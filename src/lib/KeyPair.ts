import {randomBytes} from 'crypto';
import {curve, Point} from '@dedis/kyber';
import {Buffer} from 'buffer';

const Curve25519 = curve.newCurve('edwards25519');

/**
 * KeyPair holds the private and public key that go together. It has
 * convenience methods to initialize and print the private and public
 * key.
 */
export class KeyPair {

    constructor(privHex: string = '') {
        if (privHex && privHex.length == 64) {
            this.setPrivateHex(privHex);
        } else {
            this.randomize();
        }
    }
    _private: Private;
    _public: Public;

    static fromBuffer(priv: any): KeyPair {
        return new KeyPair(Buffer.from(priv).toString('hex'));
    }

    static fromObject(obj: any) {
        return new KeyPair(Private.fromBuffer(obj.priv).toHex());
    }

    setPrivateHex(privHex: string) {
        this.setPrivate(Private.fromHex(privHex));
    }

    setPrivate(priv: Private) {
        this._private = priv;
        this._public = new Public(Curve25519.point().mul(this._private.scalar, null));
    }

    randomize() {
        this.setPrivate(Private.fromRand());
    }

    toObject(): any {
        return {
            pub: this._public.toBuffer(),
            priv: this._private.toBuffer(),
        };
    }
}

export class Private {
    constructor(public scalar: any) {
    }

    static fromBuffer(buf: Buffer): Private {
        const p = Curve25519.scalar();
        p.unmarshalBinary(buf);
        return new Private(p);
    }

    static fromHex(hex: string): Private {
        return Private.fromBuffer(Buffer.from(hex, 'hex'));
    }

    static zero(): Private {
        const p = Curve25519.scalar();
        p.zero();
        return new Private(p);
    }

    static one(): Private {
        const p = Curve25519.scalar();
        p.one();
        return new Private(p);
    }

    static fromRand(): Private {
        return new Private(Curve25519.scalar().setBytes(randomBytes(32)));
    }

    toHex(): string {
        return this.toBuffer().toString('hex');
    }

    toBuffer(): Buffer {
        return Buffer.from(this.scalar.marshalBinary());
    }

    equal(p: Private): boolean {
        return this.scalar.equal(p.scalar);
    }

    add(p: Private): Private {
        return new Private(Curve25519.scalar().add(this.scalar, p.scalar));
    }
}

export class Public {
    constructor(public point: Point) {
    }

    static base(): Public {
        const p = Curve25519.point();
        p.base();
        return new Public(p);
    }

    static fromBuffer(buf: Buffer): Public {
        const p = Curve25519.point();
        p.unmarshalBinary(buf);
        return new Public(p);
    }

    static fromProto(buf: Buffer): Public {
        const p = Curve25519.point();
        p.unmarshalBinary(Buffer.from(buf.subarray(16)));
        return new Public(p);
    }

    static fromHex(hex: string): Public {
        return Public.fromBuffer(Buffer.from(hex, 'hex'));
    }

    static zero(): Public {
        const p = Curve25519.point();
        p.null();
        return new Public(p);
    }

    static fromRand(): Public {
        const kp = new KeyPair();
        return kp._public;
    }

    equal(p: Public): boolean {
        return this.point.equals(p.point);
    }

    toHex(): string {
        return this.toBuffer().toString('hex');
    }

    toBuffer(): Buffer {
        return Buffer.from(this.point.marshalBinary());
    }

    toProto(): Buffer {
        return Buffer.from(this.point.toProto());
    }

    mul(s: Private): Public {
        const ret = Curve25519.point();
        ret.mul(s.scalar, this.point);
        return new Public(ret);
    }

    add(p: Public): Public {
        return new Public(Curve25519.point().add(this.point, p.point));
    }
}
