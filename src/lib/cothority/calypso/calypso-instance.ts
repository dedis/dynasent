import { curve, Point, Scalar } from '@dedis/kyber';
import { createHash } from 'crypto';
import Keccak from 'keccak';
import { Message, Properties } from 'protobufjs/light';
import ByzCoinRPC from '../byzcoin/byzcoin-rpc';
import ClientTransaction, { Argument, Instruction } from '../byzcoin/client-transaction';
import CoinInstance, { Coin } from '../byzcoin/contracts/coin-instance';
import Instance, { InstanceID } from '../byzcoin/instance';
import Signer from '../darc/signer';
import { registerMessage } from '../protobuf';
import {OnChainSecretRPC} from './calypso-rpc';

const curve25519 = curve.newCurve('edwards25519');

export class OnChainSecretInstance extends Instance {

    constructor(private rpc: ByzCoinRPC, inst: Instance) {
        super(inst);
        if (inst.contractID.toString() !== OnChainSecretInstance.contractID) {
            throw new Error(`mismatch contract name: ${inst.contractID} vs ${OnChainSecretInstance.contractID}`);
        }

        this.write = Write.decode(inst.data);
    }
    static readonly contractID = 'longTermSecret';
    write: Write;

    /**
     * Spawn a longTermSecret instance
     *
     * @param bc        The RPC to use
     * @param darcID    The darc instance ID
     * @param signers   The list of signers for the transaction
     * @param write The write structure containing the encrypted secret
     * @returns a promise that resolves with the new instance
     */
    static async spawn(
        bc: ByzCoinRPC,
        darcID: InstanceID,
        signers: Signer[],
    ): Promise<OnChainSecretInstance> {
        const inst = Instruction.createSpawn(
            darcID,
            OnChainSecretInstance.contractID,
            [],
        );
        await inst.updateCounters(bc, signers);

        const ctx = new ClientTransaction({instructions: [inst]});
        ctx.signWith([signers]);

        await bc.sendTransactionAndWait(ctx, 10);

        return OnChainSecretInstance.fromByzcoin(bc, inst.deriveId());
    }

    /**
     * Initializes using an existing coinInstance from ByzCoin
     * @param bc    The RPC to use
     * @param iid   The instance ID
     * @returns a promise that resolves with the coin instance
     */
    static async fromByzcoin(bc: ByzCoinRPC, iid: InstanceID): Promise<OnChainSecretInstance> {
        return new OnChainSecretInstance(bc, await Instance.fromByzCoin(bc, iid));
    }
}

export class CalypsoWriteInstance extends Instance {

    constructor(private rpc: ByzCoinRPC, inst: Instance) {
        super(inst);
        if (inst.contractID.toString() !== CalypsoWriteInstance.contractID) {
            throw new Error(`mismatch contract name: ${inst.contractID} vs ${CalypsoWriteInstance.contractID}`);
        }

        this.write = Write.decode(inst.data);
    }
    static readonly contractID = 'calypsoWrite';
    write: Write;

    /**
     * Spawn a calypsoWrite instance
     *
     * @param bc        The RPC to use
     * @param darcID    The darc instance ID
     * @param write The write structure containing the encrypted secret
     * @param signers   The list of signers for the transaction
     * @returns a promise that resolves with the new instance
     */
    static async spawn(
        bc: ByzCoinRPC,
        darcID: InstanceID,
        write: Write,
        signers: Signer[],
    ): Promise<CalypsoWriteInstance> {
        const ctx = new ClientTransaction({
            instructions: [
                Instruction.createSpawn(
                    darcID,
                    CalypsoWriteInstance.contractID,
                    [new Argument({name: 'write', value: Buffer.from(Write.encode(write).finish())})],
                ),
            ],
        });
        await ctx.updateCountersAndSign(bc, [signers]);
        await bc.sendTransactionAndWait(ctx, 10);

        return CalypsoWriteInstance.fromByzcoin(bc, ctx.instructions[0].deriveId());
    }

    /**
     * Initializes using an existing coinInstance from ByzCoin
     * @param bc    The RPC to use
     * @param iid   The instance ID
     * @returns a promise that resolves with the coin instance
     */
    static async fromByzcoin(bc: ByzCoinRPC, iid: InstanceID): Promise<CalypsoWriteInstance> {
        return new CalypsoWriteInstance(bc, await Instance.fromByzCoin(bc, iid));
    }

    async spawnRead(pub: Point, signers: Signer[], coin?: CoinInstance, coinSigners?: Signer[]):
        Promise<CalypsoReadInstance> {
        if (this.write.cost && (!coin || !coinSigners)) {
            throw new Error('spawning a read instance costs coins');
        }
        const pay = Instruction.createInvoke(coin.id, CoinInstance.contractID, 'fetch', [
            new Argument({name: 'coins', value: Buffer.from(this.write.cost.value.toBytesLE())}),
        ]);
        return CalypsoReadInstance.spawn(this.rpc, this.id, pub, signers, pay);
    }
}

export class CalypsoReadInstance extends Instance {

    constructor(private rpc: ByzCoinRPC, inst: Instance) {
        super(inst);
        if (inst.contractID.toString() !== CalypsoReadInstance.contractID) {
            throw new Error(`mismatch contract name: ${inst.contractID} vs ${CalypsoReadInstance.contractID}`);
        }

        this.read = Read.decode(inst.data);
    }
    static readonly contractID = 'calypsoRead';
    read: Read;

    static async spawn(bc: ByzCoinRPC, writeId: InstanceID, pub: Point, signers: Signer[], pay?: Instruction):
        Promise<CalypsoReadInstance> {
        const read = new Read({write: writeId, xc: pub.marshalBinary()});
        const ctx = new ClientTransaction({
            instructions: [
                Instruction.createSpawn(writeId, CalypsoReadInstance.contractID, [
                    new Argument({name: 'read', value: Buffer.from(Read.encode(read).finish())}),
                ]),
            ],
        });
        const ctxSigners = [signers];
        if (pay) {
            ctx.instructions.unshift(pay);
            ctxSigners.unshift(signers);
        }
        await ctx.updateCountersAndSign(bc, ctxSigners);
        await bc.sendTransactionAndWait(ctx);

        return CalypsoReadInstance.fromByzcoin(bc, ctx.instructions[ctx.instructions.length - 1].deriveId());
    }

    /**
     * Initializes using an existing CalypsoReadInstance from ByzCoin
     * @param bc    The RPC to use
     * @param iid   The instance ID
     * @returns a promise that resolves with the coin instance
     */
    static async fromByzcoin(bc: ByzCoinRPC, iid: InstanceID): Promise<CalypsoReadInstance> {
        return new CalypsoReadInstance(bc, await Instance.fromByzCoin(bc, iid));
    }

    async decrypt(ocs: OnChainSecretRPC, priv: Scalar): Promise<Buffer> {
        const xhatenc = await ocs.reencryptKey(await this.rpc.getProof(this.read.write),
            await this.rpc.getProof(this.id));
        return xhatenc.decrypt(priv);
    }
}

export class Write extends Message<Write> {

    constructor(props?: Properties<Write>) {
        super(props);
    }
    // in U and C
    data: Buffer;
    // U is the encrypted random value for the ElGamal encryption
    u: Buffer;

    // Data should be encrypted by the application under the symmetric key
    // Ubar is used for the log-equality proof
    ubar: Buffer;
    // E is the non-interactive challenge as scalar
    e: Buffer;
    // Ubar, E and f will be used by the server to verify the writer did
    // correctly encrypt the key. It binds the policy (the darc) with the
    // cyphertext.
    // f is the proof
    f: Buffer;
    // contain an IV)
    c: Buffer;
    // ExtraData is clear text and application-specific
    extradata: Buffer;
    // C is the ElGamal parts for the symmetric key material (might also
    // LTSID points to the identity of the lts group
    ltsid: InstanceID;
    // Cost reflects how many coins you'll have to pay for a read-request
    cost: Coin;

    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('calypso.Write', Write);
    }

    /**
     * createWrite returns a new write structure that contains a proof for the read-request
     * with regard to the LTS-ID and the write-Darc.
     * @param ltsid
     * @param writeDarc
     * @param X
     * @param key
     */
    static async createWrite(ltsid: InstanceID, writeDarc: InstanceID, X: Point, key: Buffer,
                             rand?: (length: number) => Buffer): Promise<Write> {
        // wr := &Write{LTSID: ltsid}
        const wr = new Write();
        // r := suite.Scalar().Pick(suite.RandomStream())
        const r = curve25519.scalar().pick(rand);
        // C := suite.Point().Mul(r, X)
        const C = curve25519.point().mul(r, X);
        // wr.U = suite.Point().Mul(r, nil)
        wr.u = curve25519.point().mul(r).marshalBinary();

        // Create proof
        // if len(key) > suite.Point().EmbedLen() {
        // 	return nil
        // }
        if (key.length > curve25519.point().embedLen()) {
            return Promise.reject('key is too long');
        }
        // kp := suite.Point().Embed(key, suite.RandomStream())
        const kp = curve25519.point().embed(key, rand);
        // wr.C = suite.Point().Add(C, kp)
        wr.c = curve25519.point().add(C, kp).marshalBinary();

        // gBar := suite.Point().Embed(ltsid.Slice(), keccak.New(ltsid.Slice()))
        const k = new Keccak('shake256');
        k.update(ltsid);
        const gBar = curve25519.point().embed(Buffer.from(ltsid.subarray(0, curve25519.point().embedLen())),
            (l) => k.squeeze(l));
        // wr.Ubar = suite.Point().Mul(r, gBar)
        wr.ubar = curve25519.point().mul(r, gBar).marshalBinary();
        // s := suite.Scalar().Pick(suite.RandomStream())
        const s = curve25519.scalar().pick(rand);
        // w := suite.Point().Mul(s, nil)
        const w = curve25519.point().mul(s);
        // wBar := suite.Point().Mul(s, gBar)
        const wBar = curve25519.point().mul(s, gBar);

        // hash := sha256.New()
        const hash = createHash('sha256');
        // wr.C.MarshalTo(hash)
        hash.update(wr.c);
        // wr.U.MarshalTo(hash)
        hash.update(wr.u);
        // wr.Ubar.MarshalTo(hash)
        hash.update(wr.ubar);
        // w.MarshalTo(hash)
        hash.update(w.marshalBinary());
        // wBar.MarshalTo(hash)
        hash.update(wBar.marshalBinary());
        // hash.Write(writeDarc)
        hash.update(writeDarc);
        // wr.E = suite.Scalar().SetBytes(hash.Sum(nil))
        const E = curve25519.scalar().setBytes(hash.digest());
        wr.e = E.marshalBinary();
        // wr.F = suite.Scalar().Add(s, suite.Scalar().Mul(wr.E, r))
        wr.f = curve25519.scalar().add(s, curve25519.scalar().mul(E, r)).marshalBinary();
        wr.ltsid = ltsid;
        return wr;
    }

    toBytes(): Buffer {
        return Buffer.from(Write.encode(this).finish());
    }
}

export class Read extends Message<Read> {

    constructor(props?: Properties<Read>) {
        super(props);
    }
    write: Buffer;
    xc: Buffer;

    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('calypso.Read', Read);
    }

    toBytes(): Buffer {
        return Buffer.from(Read.encode(this).finish());
    }
}

// DecodeKey can be used by the reader of ByzCoin to convert the
// re-encrypted secret back to a symmetric key that can be used later to decode
// the document.
//
// Input:
//   - suite - the cryptographic suite to use
//   - X - the aggregate public key of the DKG
//   - C - the encrypted key
//   - XhatEnc - the re-encrypted schnorr-commit
//   - xc - the private key of the reader
//
// Output:
//   - key - the re-assembled key
//   - err - an eventual error when trying to recover the data from the points
// func DecodeKey(suite kyber.Group, X kyber.Point, C kyber.Point, XhatEnc kyber.Point,
// 	xc kyber.Scalar) (key []byte, err error) {
/* tslint:disable: variable-name */
export async function DecodeKey(X: Point, C: Point, XhatEnc: Point, priv: Scalar): Promise<Buffer> {
    // 	xcInv := suite.Scalar().Neg(xc)
    const xcInv = curve25519.scalar().neg(priv);
    // 	XhatDec := suite.Point().Mul(xcInv, X)
    const XhatDec = curve25519.point().mul(xcInv, X);
    // 	Xhat := suite.Point().Add(XhatEnc, XhatDec)
    const Xhat = curve25519.point().add(XhatEnc, XhatDec);
    // 	XhatInv := suite.Point().Neg(Xhat)
    const XhatInv = curve25519.point().neg(Xhat);

    // Decrypt C to keyPointHat
    // 	keyPointHat := suite.Point().Add(C, XhatInv)
    const keyPointHat = curve25519.point().add(C, XhatInv);
    // 	key, err = keyPointHat.Data()
    return Buffer.from(keyPointHat.data());
}

Write.register();
Read.register();
