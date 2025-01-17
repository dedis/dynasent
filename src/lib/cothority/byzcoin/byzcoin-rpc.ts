import * as Long from 'long';
import Darc from '../darc/darc';
import IdentityEd25519 from '../darc/identity-ed25519';
import { IIdentity } from '../darc/identity-wrapper';
import Rules from '../darc/rules';
import { Log } from '../log';
import { IConnection, RosterWSConnection, WebSocketConnection } from '../network/connection';
import { Roster } from '../network/proto';
import { SkipBlock } from '../skipchain/skipblock';
import SkipchainRPC from '../skipchain/skipchain-rpc';
import ClientTransaction, { ICounterUpdater } from './client-transaction';
import ChainConfig from './config';
import DarcInstance from './contracts/darc-instance';
import { InstanceID } from './instance';
import Proof from './proof';
import {
    AddTxRequest,
    AddTxResponse,
    CreateGenesisBlock,
    CreateGenesisBlockResponse,
    GetProof,
    GetProofResponse,
    GetSignerCounters,
    GetSignerCountersResponse,
} from './proto/requests';

export const currentVersion = 1;

const CONFIG_INSTANCE_ID = Buffer.alloc(32, 0);

export default class ByzCoinRPC implements ICounterUpdater {

    protected constructor() {
    }

    get genesisID(): InstanceID {
        return this.genesis.computeHash();
    }

    private genesisDarc: Darc;
    private config: ChainConfig;
    private genesis: SkipBlock;
    private conn: IConnection;
    /**
     * Helper to create a genesis darc
     * @param signers       Authorized signers
     * @param roster        Roster that will be used
     * @param description   An optional description for the chain
     */
    static makeGenesisDarc(signers: IIdentity[], roster: Roster, description?: string): Darc {
        if (signers.length === 0) {
            throw new Error('no identities');
        }

        const d = Darc.newDarc(signers, signers, Buffer.from(description || 'Genesis darc'));
        roster.list.forEach((srvid) => {
            d.addIdentity('invoke:config.view_change', new IdentityEd25519({point: srvid.public}), Rules.OR);
        });

        signers.forEach((signer) => {
            d.addIdentity('spawn:darc', signer, Rules.OR);
            d.addIdentity('invoke:config.update_config', signer, Rules.OR);
        });

        return d;
    }

    /**
     * Recreate a byzcoin RPC from a given roster
     * @param roster        The roster to ask for the config and darc
     * @param skipchainID   The genesis block identifier
     */
    static async fromByzcoin(roster: Roster, skipchainID: Buffer): Promise<ByzCoinRPC> {
        const rpc = new ByzCoinRPC();
        rpc.conn = new RosterWSConnection(roster, 'ByzCoin');

        const skipchain = new SkipchainRPC(roster);
        rpc.genesis = await skipchain.getSkipBlock(skipchainID);

        const ccProof = await rpc.getProof(CONFIG_INSTANCE_ID);
        rpc.config = ChainConfig.fromProof(ccProof);

        const di = await DarcInstance.fromByzcoin(rpc, ccProof.stateChangeBody.darcID);
        rpc.genesisDarc = di.darc;

        return rpc;
    }

    /**
     * Create a new byzcoin chain and return a associated RPC
     * @param roster        The roster to use to create the genesis block
     * @param darc          The genesis darc
     * @param blockInterval The interval of block creation in nanoseconds
     */
    static async newByzCoinRPC(roster: Roster, darc: Darc, blockInterval: Long): Promise<ByzCoinRPC> {
        const rpc = new ByzCoinRPC();
        rpc.conn = new WebSocketConnection(roster.list[0].getWebSocketAddress(), 'ByzCoin');
        rpc.genesisDarc = darc;
        rpc.config = new ChainConfig({blockInterval});

        const req = new CreateGenesisBlock({
            blockInterval,
            darcContractIDs: ['darc'],
            genesisDarc: darc,
            roster,
            version: currentVersion,
        });

        const ret = await rpc.conn.send<CreateGenesisBlockResponse>(req, CreateGenesisBlockResponse);
        rpc.genesis = ret.skipblock;
        await rpc.updateConfig();

        return rpc;
    }

    /**
     * Getter for the genesis darc
     * @returns the genesis darc
     */
    getDarc(): Darc {
        return this.genesisDarc;
    }

    /**
     * Getter for the chain configuration
     * @returns the configuration
     */
    getConfig(): ChainConfig {
        return this.config;
    }

    /**
     * Getter for the genesis block
     * @returns the genesis block
     */
    getGenesis(): SkipBlock {
        return this.genesis;
    }

    /**
     * Sends a transaction to byzcoin and waits for up to 'wait' blocks for the
     * transaction to be included in the global state. If more than 'wait' blocks
     * are created and the transaction is not included, an exception will be raised.
     *
     * @param transaction is the client transaction holding
     * one or more instructions to be sent to byzcoin.
     * @param wait indicates the number of blocks to wait for the
     * transaction to be included
     * @returns a promise that gets resolved if the block has been included
     */
    sendTransactionAndWait(transaction: ClientTransaction, wait: number = 10): Promise<AddTxResponse> {
        const req = new AddTxRequest({
            inclusionwait: wait,
            skipchainID: this.genesis.hash,
            transaction,
            version: currentVersion,
        });

        return this.conn.send(req, AddTxResponse);
    }

    /**
     * Get the latest configuration for the chain and update the local
     * cache
     */
    async updateConfig(): Promise<void> {
        const pr = await this.getProof(CONFIG_INSTANCE_ID);
        this.config = ChainConfig.fromProof(pr);

        const darcIID = pr.stateChangeBody.darcID;
        const genesisDarcInstance = await DarcInstance.fromByzcoin(this, darcIID);

        this.genesisDarc = genesisDarcInstance.darc;
    }

    /**
     * Gets a proof from byzcoin to show that a given instance is in the
     * global state.
     *
     * @param id the instance key
     * @return a promise that resolves with the proof, rejecting otherwise
     */
    async getProof(id: Buffer): Promise<Proof> {
        const req = new GetProof({
            id: this.genesis.hash,
            key: id,
            version: currentVersion,
        });

        const reply = await this.conn.send<GetProofResponse>(req, GetProofResponse);
        // const err = reply.proof.verify(this.genesis.hash);
        // if (err) {
        //     throw new Error(`invalid proof: ${err.message}`);
        // }

        return reply.proof;
    }

    /**
     * Get the latest counter for the given signers and increase it with a given value
     *
     * @param ids The identifiers of the signers
     * @param add The increment
     * @returns the ordered list of counters
     */
    async getSignerCounters(ids: IIdentity[], add: number = 0): Promise<Long[]> {
        const req = new GetSignerCounters({
            signerIDs: ids.map((id) => id.toString()),
            skipchainID: this.genesis.hash,
        });

        try {
            const rep = await this.conn.send<GetSignerCountersResponse>(req, GetSignerCountersResponse);
            return rep.counters.map((c) => c.add(add));
        } catch (e) {
            return Log.rcatch(e);
        }
    }
}
