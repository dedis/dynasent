import { Properties } from 'protobufjs';
import ByzCoinRPC from './byzcoin-rpc';
import Proof from './proof';

export type InstanceID = Buffer;

/**
 * Instance with basic information
 */
export default class Instance {

    protected constructor(init: Properties<Instance> | Instance) {
        this.id = init.id;
        this.contractID = init.contractID;
        this.darcID = init.darcID;
        this.data = init.data;
    }

    id: InstanceID;
    contractID: string;
    darcID: InstanceID;
    data: Buffer;
    /**
     * Create an instance from a proof
     * @param p The proof
     * @returns the instance
     */
    static fromProof(key: InstanceID, p: Proof): Instance {
        if (!p.exists(key)) {
            throw new Error(`key not in proof: ${key.toString('hex')}`);
        }

        return Instance.fromFields(key, p.contractID, p.darcID, p.value);
    }

    /**
     * Create an instance after requesting its proof to byzcoin
     * @param rpc   The RPC to use
     * @param id    The ID of the instance
     * @returns the instance if it exists
     */
    static async fromByzCoin(rpc: ByzCoinRPC, id: InstanceID): Promise<Instance> {
        const p = await rpc.getProof(id);

        return Instance.fromProof(id, p);
    }

    /**
     * Creates a new instance from separated fields.
     * @param id
     * @param contractID
     * @param darcID
     * @param data
     */
    static fromFields(id: InstanceID, contractID: string, darcID: InstanceID, data: Buffer): Instance {
        return new Instance({id, contractID, darcID, data});
    }

    /**
     * Returns an instance from a previously toBytes() call.
     * @param buf
     */
    static fromBytes(buf: Buffer): Instance {
        const obj = JSON.parse(buf.toString());
        return new Instance({
            contractID: obj.contractID,
            darcID: Buffer.from(obj.darcID),
            data: Buffer.from(obj.data),
            id: Buffer.from(obj.id),
        });
    }

    /**
     * Returns a byte representation of the Instance.
     */
    toBytes(): Buffer {
        return Buffer.from(JSON.stringify(this));
    }
}
