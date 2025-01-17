import * as Long from 'long';
import {Message, Properties} from 'protobufjs/light';
import Signer from '../../darc/signer';
import {EMPTY_BUFFER, registerMessage} from '../../protobuf';
import ByzCoinRPC from '../byzcoin-rpc';
import ClientTransaction, {Argument, Instruction} from '../client-transaction';
import Instance, {InstanceID} from '../instance';
import {createHash} from 'crypto';

export default class CoinInstance extends Instance {

    constructor(private rpc: ByzCoinRPC, inst: Instance) {
        super(inst);
        if (inst.contractID.toString() !== CoinInstance.contractID) {
            throw new Error(`mismatch contract name: ${inst.contractID} vs ${CoinInstance.contractID}`);
        }

        this.coin = Coin.decode(inst.data);
    }

    /**
     * Getter for the coin name
     * @returns the name
     */
    get name(): Buffer {
        return this.coin.name;
    }

    /**
     * Getter for the coin value
     * @returns the value
     */
    get value(): Long {
        return this.coin.value;
    }
    static readonly contractID = 'coin';
    static readonly commandMint = 'mint';

    public coin: Coin;

    /**
     * Generate the coin instance ID for a given darc ID
     *
     * @param buf Any buffer that is known to the caller
     * @returns the id as a buffer
     */
    static coinIID(buf: Buffer): InstanceID {
        const h = createHash('sha256');
        h.update(Buffer.from(CoinInstance.contractID));
        h.update(buf);
        return h.digest();
    }

    /**
     * Spawn a coin instance from a darc id
     *
     * @param bc        The RPC to use
     * @param darcID    The darc instance ID
     * @param signers   The list of signers for the transaction
     * @param type      The coin instance type
     * @returns a promise that resolves with the new instance
     */
    static async spawn(
        bc: ByzCoinRPC,
        darcID: InstanceID,
        signers: Signer[],
        type: Buffer,
    ): Promise<CoinInstance> {
        const inst = Instruction.createSpawn(
            darcID,
            CoinInstance.contractID,
            [new Argument({name: 'type', value: type})],
        );
        await inst.updateCounters(bc, signers);

        const ctx = new ClientTransaction({instructions: [inst]});
        ctx.signWith([signers]);

        await bc.sendTransactionAndWait(ctx, 10);

        return CoinInstance.fromByzcoin(bc, inst.deriveId());
    }

    /**
     * Create returns a CoinInstance from the given parameters.
     * @param bc
     * @param coinID
     * @param darcID
     * @param coin
     */
    static create(
        bc: ByzCoinRPC,
        coinID: InstanceID,
        darcID: InstanceID,
        coin: Coin,
    ): CoinInstance {
        return new CoinInstance(bc, Instance.fromFields(coinID, CoinInstance.contractID, darcID, coin.toBytes()));
    }

    /**
     * Initializes using an existing coinInstance from ByzCoin
     * @param bc    The RPC to use
     * @param iid   The instance ID
     * @returns a promise that resolves with the coin instance
     */
    static async fromByzcoin(bc: ByzCoinRPC, iid: InstanceID): Promise<CoinInstance> {
        return new CoinInstance(bc, await Instance.fromByzCoin(bc, iid));
    }

    /**
     * Transfer a certain amount of coin to another account.
     *
     * @param coins     the amount
     * @param to        the destination account (must be a coin contract instance id)
     * @param signers   the signers (of the giver account)
     */
    async transfer(coins: Long, to: Buffer, signers: Signer[]): Promise<void> {
        const args = [
            new Argument({name: 'coins', value: Buffer.from(coins.toBytesLE())}),
            new Argument({name: 'destination', value: to}),
        ];

        const inst = Instruction.createInvoke(this.id, CoinInstance.contractID, 'transfer', args);
        await inst.updateCounters(this.rpc, signers);

        const ctx = new ClientTransaction({instructions: [inst]});
        ctx.signWith([signers]);

        await this.rpc.sendTransactionAndWait(ctx, 10);
    }

    /**
     * Mine a given amount of coins
     *
     * @param signers   The list of signers for the transaction
     * @param amount    The amount to add to the coin instance
     * @param wait      Number of blocks to wait for inclusion
     */
    async mint(signers: Signer[], amount: Long, wait?: number): Promise<void> {
        const inst = Instruction.createInvoke(
            this.id,
            CoinInstance.contractID,
            CoinInstance.commandMint,
            [new Argument({name: 'coins', value: Buffer.from(amount.toBytesLE())})],
        );
        await inst.updateCounters(this.rpc, signers);

        const ctx = new ClientTransaction({instructions: [inst]});
        ctx.signWith([signers]);

        await this.rpc.sendTransactionAndWait(ctx, wait);
    }

    /**
     * Update the data of this instance
     *
     * @returns the updated instance
     */
    async update(): Promise<CoinInstance> {
        const p = await this.rpc.getProof(this.id);
        if (!p.exists(this.id)) {
            throw new Error('fail to get a matching proof');
        }

        this.coin = Coin.decode(p.value);
        return this;
    }
}

export class Coin extends Message<Coin> {

    constructor(props?: Properties<Coin>) {
        super(props);

        this.name = Buffer.from(this.name || EMPTY_BUFFER);
    }

    name: Buffer;
    value: Long;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('byzcoin.Coin', Coin);
    }

    toBytes(): Buffer {
        return Buffer.from(Coin.encode(this).finish());
    }
}

Coin.register();
