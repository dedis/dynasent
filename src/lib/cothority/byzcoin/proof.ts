import { createHash } from 'crypto';
import * as _ from 'lodash';
import * as Long from 'long';
import { Message, Properties } from 'protobufjs/light';
import { registerMessage } from '../protobuf';
import { SkipchainRPC } from '../skipchain';
import { ForwardLink, SkipBlock } from '../skipchain/skipblock';
import Instance, { InstanceID } from './instance';
import DataHeader from './proto/data-header';

/**
 * The proof class represents a proof that a given instance with its data is either present or absent in the global
 * state. It does this by proving three different things:
 *
 * 1. that there is a valid chain of blocks from the genesis to the latest block
 * 2. a copy of the latest block to get the root hash of the global state trie
 * 3. an inclusion proof against the root hash that can be positive (element is there) or negative (absence of element)
 *
 * As the element that is proven is always an instance, this class also has convenience methods to access the
 * instance data in case it is a proof of existence. For absence proofs, these methods will throw an error.
 */
export default class Proof extends Message<Proof> {

    constructor(props: Properties<Proof>) {
        super(props);

        this.links = this.links || [];
    }

    /**
     * Get the state change stored in the inclusion proof
     *
     * @returns the state change body
     */
    get stateChangeBody(): StateChangeBody {
        if (!this._state) {
            // cache the decoding
            this._state = StateChangeBody.decode(this.inclusionproof.value);
        }

        return this._state;
    }

    /**
     * Returns the contractID this proof represents. Throws an error if it
     * is a proof of absence.
     *
     * @returns the contract ID as a buffer
     */
    get contractID(): string {
        return this.stateChangeBody.contractID;
    }

    /**
     * Get the darc ID of the instance
     *
     * @returns the darcID responsible for the instanceID this proof represents.
     */
    get darcID(): Buffer {
        return this.stateChangeBody.darcID;
    }

    /**
     * The value of the instance is different from the value stored in the global state.
     *
     * @returns the value of the instance this proof represents.
     */
    get value(): Buffer {
        return this.stateChangeBody.value;
    }

    /**
     * Get the instance ID for the proof
     *
     * @returns the instance ID as a buffer
     */
    get key(): Buffer {
        return this.inclusionproof.key;
    }

    readonly inclusionproof: InclusionProof;
    readonly latest: SkipBlock;
    readonly links: ForwardLink[];

    protected _state: StateChangeBody;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('byzcoin.Proof', Proof, InclusionProof, SkipBlock, ForwardLink);
    }

    async getVerifiedInstance(genesisID: InstanceID, contractID: string): Promise<Instance> {
        const err = this.verify(genesisID);
        if (err != null) {
            return Promise.reject(err);
        }
        if (!this.exists(this.key)) {
            return Promise.reject('cannot return an Instance from a proof of absence');
        }
        if (this.contractID !== contractID) {
            return Promise.reject('not of correct contractID');
        }
        return Instance.fromFields(this.key, this.contractID, this.darcID, this.value);
    }

    /**
     * Verify that the proof contains a correct chain from the given genesis
     *
     * @param genesisID The skipchain ID
     * @returns an error if something is wrong, null otherwise
     */
    verify(genesisID: InstanceID): Error {
        if (!this.latest.computeHash().equals(this.latest.hash)) {
            return new Error('invalid latest block');
        }

        const header = DataHeader.decode(this.latest.data);
        if (!this.inclusionproof.hashInterior(0).equals(header.trieRoot)) {
            return new Error('invalid root');
        }

        let publics = this.latest.roster.getServicePublics(SkipchainRPC.serviceName);
        let prev = this.links[0].to;

        if (!prev.equals(genesisID)) {
            return new Error('first link must come from the genesis block');
        }

        const links = this.links;
        for (let i = 1; i < links.length; i++) {
            const link = links[i];

            const err = link.verify(publics);
            if (err) {
                return new Error('invalid forward link signature: ' + err.message);
            }

            if (!link.from.equals(prev)) {
                return new Error('invalid chain of forward links');
            }

            prev = link.to;

            if (link.newRoster) {
                publics = link.newRoster.getServicePublics(SkipchainRPC.serviceName);
            }
        }

        if (!prev.equals(this.latest.hash)) {
            return new Error('last forward link does not point to the latest block');
        }

        return null;
    }

    /**
     * Check if the key exists in the proof
     *
     * @returns true when it exists, false otherwise
     * @throws for corrupted proofs
     */
    exists(key: Buffer): boolean {
        if (key.length === 0) {
            throw new Error('key is nil');
        }
        if (this.inclusionproof.interiors.length === 0) {
            throw new Error('no interior node');
        }

        const bits = hashToBits(key);
        let expectedHash = this.inclusionproof.hashInterior(0);

        let i = 0;
        for (; i < this.inclusionproof.interiors.length; i++) {
            if (!expectedHash.equals(this.inclusionproof.hashInterior(i))) {
                throw new Error('invalid interior node');
            }

            if (bits[i]) {
                expectedHash = this.inclusionproof.interiors[i].left;
            } else {
                expectedHash = this.inclusionproof.interiors[i].right;
            }
        }

        if (expectedHash.equals(this.inclusionproof.hashLeaf())) {
            // if (_.difference(bits.slice(0, i), this.inclusionproof.leaf.prefix).length !== 0) {
            if (_.difference(bits.slice(0, i), this.inclusionproof.leaf.prefix).length !== 0) {
                throw new Error('invalid prefix in leaf node');
            }

            return this.key.equals(key);
        } else if (expectedHash.equals(this.inclusionproof.hashEmpty())) {
            if (_.difference(bits.slice(0, i), this.inclusionproof.empty.prefix).length !== 0) {
                throw new Error('invalid prefix in empty node');
            }

            return false;
        }

        throw new Error('no corresponding leaf/empty node with respect to the interior node');
    }

    /**
     * @param cid contractID to check
     * @returns true if it is a proof of existence and the given type of contract matches.
     */
    matchContract(cid: string): boolean {
        return this.stateChangeBody.contractID.toString() === cid;
    }

    /**
     * @returns a nicely formatted representation of the proof.
     */
    toString(): string {
        return `Proof for contractID(${this.contractID}) for ${this.key}`;
    }
}

/**
 * Get an array of booleans depending on the binary representation
 * of the key
 *
 * @param key the key to hash
 * @returns an array of booleans matching the key binary value
 */
function hashToBits(key: Buffer): boolean[] {
    const h = createHash('sha256');
    h.update(key);
    const hash = h.digest();

    const bits = new Array(hash.length * 8);
    for (let i = 0; i < bits.length; i++) {
        // tslint:disable-next-line no-bitwise
        bits[i] = ((hash[i >> 3] << (i % 8)) & (1 << 7)) > 0;
    }

    return bits;
}

/**
 * Get a buffer from an array of boolean converted in binary
 *
 * @param bits the array of booleans
 * @returns a buffer of the binary shape
 */
function boolToBuffer(bits: boolean[]): Buffer {
    // tslint:disable-next-line no-bitwise
    const buf = Buffer.alloc((bits.length + 7) >> 3, 0);

    for (let i = 0; i < bits.length; i++) {
        if (bits[i]) {
            // tslint:disable-next-line no-bitwise
            buf[i >> 3] |= (1 << 7) >> (i % 8);
        }
    }

    return buf;
}

/**
 * Interior node of an inclusion proof
 */
class InteriorNode extends Message<InteriorNode> {

    readonly left: Buffer;
    readonly right: Buffer;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('trie.InteriorNode', InteriorNode);
    }
}

/**
 * Empty node of an inclusion proof
 */
class EmptyNode extends Message<EmptyNode> {

    constructor(props?: Properties<EmptyNode>) {
        super(props);

        this.prefix = this.prefix || [];
    }

    readonly prefix: boolean[];
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('trie.EmptyNode', EmptyNode);
    }
}

/**
 * Leaf node of an inclusion proof
 */
class LeafNode extends Message<LeafNode> {

    constructor(props?: Properties<LeafNode>) {
        super(props);

        this.prefix = this.prefix || [];
    }

    readonly prefix: boolean[];
    readonly key: Buffer;
    readonly value: Buffer;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('trie.LeafNode', LeafNode);
    }
}

/**
 * InclusionProof represents the proof that an instance is present or not in the global state trie.
 */
class InclusionProof extends Message<InclusionProof> {

    constructor(props?: Properties<InclusionProof>) {
        super(props);

        this.interiors = this.interiors || [];
    }

    /**
     * @return {Buffer} the key in the leaf for this inclusionProof. This is not the same as the key this proof has
     * been created for!
     */
    get key(): Buffer {
        return this.leaf.key;
    }

    /**
     * @return {Buffer} the value stored in the instance. The value of an instance holds the contractID, darcID,
     * version and the data of the instance.
     */
    get value(): Buffer {
        return this.leaf.value;
    }

    interiors: InteriorNode[];
    leaf: LeafNode;
    empty: EmptyNode;
    nonce: Buffer;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('trie.Proof', InclusionProof, InteriorNode, LeafNode, EmptyNode);
    }

    /**
     * Get the hash of the interior node at the given index
     *
     * @param index the index of the interior node
     * @returns the hash as a buffer
     */
    hashInterior(index: number): Buffer {
        const h = createHash('sha256');
        h.update(this.interiors[index].left);
        h.update(this.interiors[index].right);

        return h.digest();
    }

    /**
     * Get the hash of the leaf of the inclusion proof
     *
     * @returns the hash as a buffer
     */
    hashLeaf(): Buffer {
        const h = createHash('sha256');
        h.update(Buffer.from([3]));
        h.update(this.nonce);

        const prefix = boolToBuffer(this.leaf.prefix);
        h.update(prefix);

        const length = Buffer.allocUnsafe(4);
        length.writeIntLE(this.leaf.prefix.length, 0, 4);
        h.update(length);

        h.update(this.leaf.key);
        h.update(this.leaf.value);

        return h.digest();
    }

    /**
     * Get the hash of the empty node of the inclusion proof
     *
     * @returns the hash of the empty node
     */
    hashEmpty(): Buffer {
        const h = createHash('sha256');
        h.update(Buffer.from([2]));
        h.update(this.nonce);

        const prefix = boolToBuffer(this.empty.prefix);
        h.update(prefix);

        const length = Buffer.allocUnsafe(4);
        length.writeIntLE(this.empty.prefix.length, 0, 4);
        h.update(length);

        return h.digest();
    }
}

export class StateChangeBody extends Message<StateChangeBody> {

    constructor(props?: Properties<StateChangeBody>) {
        super(props);
    }

    get contractID(): string {
        return this.contractid;
    }

    get darcID(): Buffer {
        return this.darcid;
    }

    readonly stateaction: number;
    readonly contractid: string;
    readonly value: Buffer;
    readonly version: Long;
    readonly darcid: Buffer;
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('StateChangeBody', StateChangeBody);
    }

    static fromBytes(b: Buffer): StateChangeBody {
        return StateChangeBody.decode(b);
    }

    /**
     * Helper to encode the StateChangeBody using protobuf
     * @returns the bytes
     */
    toBytes(): Buffer {
        return Buffer.from(StateChangeBody.encode(this).finish());
    }
}

Proof.register();
InclusionProof.register();
InteriorNode.register();
LeafNode.register();
EmptyNode.register();
StateChangeBody.register();
