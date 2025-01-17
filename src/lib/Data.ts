/* This is the main library for storing and getting things from the phone's file
 * system.
 */
import {PersonhoodRPC, PollStruct} from './cothority/personhood/personhood-rpc';
import ByzCoinRPC from './cothority/byzcoin/byzcoin-rpc';

import * as Long from 'long';
import {Defaults} from './Defaults';
import {Storage} from './Storage';
import {Log} from './cothority/log';
import {KeyPair, Private, Public} from './KeyPair';
import {Buffer} from 'buffer';
import Instance, {InstanceID} from './cothority/byzcoin/instance';
import DarcInstance from './cothority/byzcoin/contracts/darc-instance';
import CredentialInstance, {
    Attribute,
    Credential,
    CredentialStruct,
    RecoverySignature
} from './cothority/byzcoin/contracts/credentials-instance';
import CoinInstance from './cothority/byzcoin/contracts/coin-instance';
import {TestStoreRPC} from './TestStoreRPC';
import SpawnerInstance, {SPAWNER_COIN} from './cothority/byzcoin/contracts/spawner-instance';
import Signer from './cothority/darc/signer';
import SignerEd25519 from './cothority/darc/signer-ed25519';
import {Contact} from './Contact';
import {Badge} from './Badge';
import {Party} from './Party';
import {PopPartyInstance} from './cothority/personhood/pop-party-instance';
import RoPaSciInstance from './cothority/personhood/ro-pa-sci-instance';
import {SocialNode} from './SocialNode';
import {sprintf} from 'sprintf-js';
import {parseQRCode} from './Scan';
import Darc from './cothority/darc/darc';
import {Roster} from './cothority/network';
import ClientTransaction, {Argument, Instruction} from './cothority/byzcoin/client-transaction';
import IdentityDarc from './cothority/darc/identity-darc';
import {Scalar} from '@dedis/kyber';
import IdentityEd25519 from './cothority/darc/identity-ed25519';
import {LongTermSecret, OnChainSecretRPC} from './cothority/calypso/calypso-rpc';

const curve = require('@dedis/kyber').curve.newCurve('edwards25519');
const Schnorr = require('@dedis/kyber').sign.schnorr;


/**
 * Data holds the data of the app.
 */
export class Data {

    static readonly urlRecoveryRequest = 'https://pop.dedis.ch/recoveryReq-1';
    static readonly urlRecoverySignature = 'https://pop.dedis.ch/recoverySig-1';
    dataFileName: string;
    continuousScan: boolean;
    personhoodPublished: boolean;
    keyPersonhood: KeyPair;
    keyIdentity: KeyPair;
    bc: ByzCoinRPC = null;
    lts: LongTermSecret = null;
    constructorObj: any;
    contact: Contact = null;
    contacts: Contact[] = [];
    parties: Party[] = [];
    badges: Badge[] = [];
    ropascis: RoPaSciInstance[] = [];
    polls: PollStruct[] = [];
    meetups: SocialNode[] = [];
    // Non-stored fields
    recoverySignatures: RecoverySignature[] = [];

    /**
     * Constructs a new Data, optionally initialized with an object containing
     * fields for initialization of the class.
     * @param obj (optional) object with all fields for the class.
     */
    constructor(obj: any = {}) {
        this.constructorObj = obj;
        this.setValues(obj);
        this.setFileName('data.json');
    }

    get keyIdentitySigner(): Signer {
        return new SignerEd25519(this.keyIdentity._public.point, this.keyIdentity._private.scalar);
    }

    get darcInstance(): DarcInstance {
        return this.contact.darcInstance;
    }

    get coinInstance(): CoinInstance {
        return this.contact.coinInstance;
    }

    get credentialInstance(): CredentialInstance {
        return this.contact.credentialInstance;
    }

    get alias(): string {
        return this.contact.alias;
    }

    get spawnerInstance(): SpawnerInstance {
        return this.contact.spawnerInstance;
    }

    set spawnerInstance(si: SpawnerInstance) {
        this.contact.spawnerInstance = si;
    }

    get uniqueMeetings(): number {
        const meetups = this.meetups.map(m => Contact.sortAlias(m.users));
        const unique = meetups.filter((meetup, i) =>
            meetups.findIndex(m => m.join() === meetup.join()) === i);
        return unique.length;
    }

    // createFirstUser sets up a new user with all the necessary darcs. It does the following:
    // - creates all necessary darcs (four)
    // - creates credential and coin
    // If darcID is given, it will use this darc to create all the instances. If darcID == null,
    // then the gData needs to have enough coins to pay for all the instances when using

    // the 'SpawnerInstance'.
    static async createFirstUser(bc: ByzCoinRPC, adminDarc: InstanceID, adminKey: Scalar, alias: string): Promise<Data> {
        const d = new Data({alias, bc});
        const adminPub = Public.base().mul(Private.fromBuffer(adminKey.marshalBinary()));
        const adminSigner = new SignerEd25519(adminPub.point, adminKey);

        const darcDevice = Darc.newDarc([d.keyIdentitySigner]
            , [d.keyIdentitySigner], Buffer.from('device'));
        const darcDeviceId = new IdentityDarc({id: darcDevice.getBaseID()});
        const darcSign = Darc.newDarc([darcDeviceId], [darcDeviceId], Buffer.from('signer'));
        const darcSignId = new IdentityDarc({id: darcSign.getBaseID()});
        const darcCred = Darc.newDarc([], [darcSignId], Buffer.from('credential'),
            ['invoke:' + CredentialInstance.contractID + '.update']);
        const rules = ['mint', 'transfer', 'fetch', 'store'].map(inv => sprintf('invoke:%s.%s', CoinInstance.contractID, inv));
        const darcCoin = Darc.newDarc([], [darcSignId], Buffer.from('coin'), rules);

        Log.lvl2('Creating spawner');
        const costs = {
            costCoin: Long.fromNumber(100),
            costCredential: Long.fromNumber(1000),
            costDarc: Long.fromNumber(100),
            costParty: Long.fromNumber(1000),
            costCWrite: Long.fromNumber(1000),
            costCRead: Long.fromNumber(100)
        };
        const spawner = await SpawnerInstance.spawn({
            bc,
            darcID: adminDarc,
            signers: [adminSigner],
            costs,
            beneficiary: null
        });

        const ocs = new OnChainSecretRPC(bc);
        try {
            await ocs.authoriseRoster();
        } catch (e) {
            Log.error('Could not authorize roster', e);
        }
        const lts = await LongTermSecret.spawn(bc, adminDarc, [adminSigner]);

        const cred = Contact.prepareInitialCred(alias, d.keyIdentity._public, spawner.id, lts);

        Log.lvl1('Creating coin from darc');
        const signers = [adminSigner];
        const ctx = new ClientTransaction({
            instructions:
                [darcDevice, darcSign, darcCred, darcCoin].map(dar => {
                        return Instruction.createSpawn(adminDarc, DarcInstance.contractID, [
                            new Argument({name: 'darc', value: dar.toBytes()})
                        ]);
                    }
                )
        });
        const idBuf = d.keyIdentity._public.toBuffer();
        ctx.instructions.push(Instruction.createSpawn(adminDarc, CoinInstance.contractID, [
            new Argument({name: 'coinID', value: idBuf}),
            new Argument({name: 'darcID', value: darcCoin.getBaseID()}),
            new Argument({name: 'type', value: SPAWNER_COIN})
        ]));
        ctx.instructions.push(Instruction.createSpawn(adminDarc, CredentialInstance.contractID, [
            new Argument({name: 'credID', value: idBuf}),
            new Argument({name: 'darcID', value: darcCred.getBaseID()}),
            new Argument({name: 'credential', value: cred.toBytes()})
        ]));
        const amount = Long.fromNumber(1e9);
        ctx.instructions.push(Instruction.createInvoke(CoinInstance.coinIID(idBuf),
            CoinInstance.contractID,
            CoinInstance.commandMint,
            [new Argument({name: 'coins', value: Buffer.from(amount.toBytesLE())})]));

        await ctx.updateCountersAndSign(bc, [signers, signers, signers, signers, signers, signers, [d.keyIdentitySigner]]);
        await bc.sendTransactionAndWait(ctx, 5);

        Log.lvl2('Linking new data to Data-structure');
        d.contact = new Contact(cred, d);
        d.bc = bc;
        await d.contact.connectBC(bc);
        await d.connectByzcoin();
        Log.lvl2('done');
        return d;
    }

    /**
     * findSignerDarc takes a darc from a credential, coin, or writeInstance, and follows the first
     * signer. This is supposed to be the signer darc of whoever has the right to work on this
     * instance.
     *
     * @param bc a working ByzCoin instance
     * @param darcID the id of the darc that controls an instance
     */
    static async findSignerDarc(bc: ByzCoinRPC, darcID: InstanceID): Promise<DarcInstance> {
        const d = await DarcInstance.fromByzcoin(bc, darcID);
        const signer = d.getSignerDarcIDs();
        if (signer.length === 0) {
            throw new Error('Didn\'t find signer');
        }
        return DarcInstance.fromByzcoin(bc, signer[0]);
    }

    setFileName(n: string) {
        this.dataFileName = Defaults.DataDir + '/' + n;
    }

    setValues(obj: any) {
        this.constructorObj = obj;
        try {
            this.continuousScan = obj.continuousScan ? obj.continuousScan : false;
            this.personhoodPublished = obj.personhoodPublished ? obj.personhoodPublished : false;
            this.keyPersonhood = obj.keyPersonhood ? new KeyPair(obj.keyPersonhood) : new KeyPair();
            this.keyIdentity = obj.keyIdentity ? new KeyPair(obj.keyIdentity) : new KeyPair();
            this.meetups = obj.meetups ? obj.meetups.map(m => SocialNode.fromObject(m)) : [];

            if (obj.contact != null) {
                this.contact = Contact.fromObject(obj.contact);
                this.contact.data = this;
            } else {
                this.contact = new Contact(Contact.prepareInitialCred('new identity', this.keyIdentity._public,
                    null, null), this);
            }
            if (obj.contacts) {
                this.contacts = obj.contacts.map(c => Contact.fromObject(c));
            }
        } catch (e) {
            Log.catch(e);
        }
    }

    delete() {
        this.setValues({});
        this.bc = null;
        this.constructorObj = {};
        this.meetups = [];
        this.parties = [];
        this.badges = [];
        this.ropascis = [];
        this.polls = [];
        this.contacts = [];
    }

    async connectByzcoin(): Promise<ByzCoinRPC> {
        try {
            const obj = this.constructorObj;
            let bcID: Buffer;
            if (this.bc != null) {
                Log.lvl2('Not connecting if bc is already initialized');
                this.lts = new LongTermSecret(this.bc, this.contact.ltsID, this.contact.ltsX);
            } else if (Defaults.LoadTestStore && this.bc == null) {
                Log.lvl1('Loading data from TestStoreRPC');
                const ts = await TestStoreRPC.load(Defaults.Roster);
                Defaults.ByzCoinID = ts.byzcoinID;
                Log.lvl1('Updated Defaults bcID:', ts.byzcoinID);
                bcID = obj.bcID ? Buffer.from(obj.bcID) : Defaults.ByzCoinID;
                const roster = obj.roster ? Roster.fromObject(obj.roster) : Defaults.Roster;
                if (bcID == null || bcID.length === 0) {
                    if (Defaults.Testing) {
                        return;
                    } else {
                        return Promise.reject('Cannot connect to ByzCoin');
                    }
                }
                this.bc = await ByzCoinRPC.fromByzcoin(roster, bcID);
            } else if (this.bc == null) {
                this.bc = await ByzCoinRPC.fromByzcoin(Defaults.Roster, Defaults.ByzCoinID);
            }

            Log.lvl2('getting parties and badges');
            if (obj.parties) {
                this.parties = obj.parties.map(p => Party.fromObject(this.bc, p));
            }
            if (obj.badges) {
                this.badges = obj.badges.map(b => Badge.fromObject(this.bc, b));
                this.badges = this.badges.filter((badge, i) =>
                    this.badges.findIndex(b => b.party.uniqueName === badge.party.uniqueName) === i);
            }

            Log.lvl2('Getting rock-paper-scissors and polls');
            if (obj.ropascis) {
                this.ropascis = obj.ropascis.map(rps =>
                    new RoPaSciInstance(this.bc, Instance.fromBytes(Buffer.from(rps))));
            }
            if (obj.polls) {
                this.polls = obj.polls.map(rps => PollStruct.fromObject(rps));
            }

            if (obj.contact) {
                this.contact = await Contact.fromObjectBC(this.bc, obj.contact);
            } else if (this.contact) {
                await this.contact.connectBC(this.bc);
            }
            this.contact.data = this;
            this.lts = new LongTermSecret(this.bc, this.contact.ltsID, this.contact.ltsX);

            Log.lvl2('Getting contact informations');
            this.contacts = [];
            if (obj.contacts) {
                const fs = obj.contacts.filter(u => u);
                for (const f of fs) {
                    this.contacts.push(await Contact.fromObjectBC(this.bc, f));
                }
            }
        } catch (e) {
            await Log.rcatch(e);
        }
        return this.bc;
    }

    toObject(): any {
        const v = {
            continuousScan: this.continuousScan,
            personhoodPublished: this.personhoodPublished,
            keyPersonhood: this.keyPersonhood._private.toHex(),
            keyIdentity: this.keyIdentity._private.toHex(),
            friends: this.contacts.map(u => u.toObject()),
            meetups: this.meetups.map(m => m.toObject()),
            contact: this.contact.toObject(),
            contacts: this.contacts.map(c => c.toObject()),
            bcRoster: null,
            bcID: null,
            darcInstance: null,
            credentialInstance: null,
            coinInstance: null,
            parties: [],
            badges: [],
            ropascis: [],
            polls: [],
        };
        if (this.bc) {
            v.bcRoster = this.bc.getConfig().roster.toJSON();
            v.bcID = this.bc.getGenesis().computeHash();
            v.parties = this.parties ? this.parties.map(p => p.toObject()) : null;
            v.badges = this.badges ? this.badges.map(b => b.toObject()) : null;
            v.ropascis = this.ropascis ? this.ropascis.map(rps => rps.toBytes()) : null;
            v.polls = this.polls ? this.polls.map(rps => rps.toObject()) : null;
        }
        return v;
    }

    async publishPersonhood(publish: boolean) {
        this.personhoodPublished = publish;
        if (publish) {
            try {
                Log.lvl2('Personhood not yet stored - adding to credential');
                this.contact.credential.setAttribute('personhood',
                    'ed25519', this.keyPersonhood._public.toBuffer());
                await this.contact.sendUpdate();
            } catch (e) {
                Log.catch(e);
            }
        }
    }

    /**
     * Returns a promise with the loaded Data in it, when available. If the file
     * is not found, it returns an empty data.
     */
    async load(): Promise<Data> {
        try {
            await this.setValues(Storage.getObject(this.dataFileName));
        } catch (e) {
            Log.catch(e);
        }
        this.bc = null;
        await this.connectByzcoin();
        return this;
    }

    async save(): Promise<Data> {
        Storage.putObject(this.dataFileName, this.toObject());
        if (this.personhoodPublished) {
            this.contact.credential.setAttribute('personhood',
                'ed25519', this.keyPersonhood._public.toBuffer());
        }
        if (this.contact.isRegistered()) {
            await this.contact.sendUpdate();
        }
        return this;
    }

    async canPay(amount: Long): Promise<boolean> {
        if (!(this.coinInstance && this.spawnerInstance)) {
            return Promise.reject('Cannot sign up a contact without coins and spawner');
        }
        await this.coinInstance.update();
        if (amount.lessThanOrEqual(0)) {
            return Promise.reject('Cannot send 0 or less coins');
        }
        if (amount.greaterThanOrEqual(this.coinInstance.coin.value)) {
            return Promise.reject('You only have ' + this.coinInstance.coin.value.toString() + ' coins.');
        }
        return true;
    }

    dummyProgress(text: string = '', width: number = 0) {
        Log.lvl2('Dummyprogress:', text, width);
    }

    async registerContact(contact: Contact, balance: Long = Long.fromNumber(0),
                          progress: (text: string, width: number) => void = this.dummyProgress): Promise<any> {
        try {
            progress('Verifying Registration', 10);
            if (contact.isRegistered()) {
                return Promise.reject('cannot register already registered contact');
            }
            const pub = contact.seedPublic;
            Log.lvl2('Registering contact', contact.alias,
                'with public key:', pub.toHex());
            Log.lvl2('Registering darc');
            progress('Creating Darc', 20);
            const d = Contact.prepareUserDarc(pub.point, contact.alias);
            const darcInstances = await this.spawnerInstance.spawnDarc(this.coinInstance,
                [this.keyIdentitySigner], d);

            progress('Creating Coin', 50);
            Log.lvl2('Registering coin');
            const coinInstance = await this.spawnerInstance.spawnCoin(this.coinInstance,
                [this.keyIdentitySigner], darcInstances[0].darc.getBaseID(), contact.seedPublic.toBuffer());
            let referral = null;
            if (this.contact.credentialInstance) {
                referral = this.contact.credentialInstance.id;
                Log.lvl2('Adding a referral to the credentials');
            }
            Log.lvl2('Registering credential');

            progress('Creating Credential', 80);
            const credentialInstance = await this.createUserCredentials(pub, darcInstances[0].id, coinInstance.id,
                referral, contact);
            await this.coinInstance.transfer(balance, coinInstance.id, [this.keyIdentitySigner]);
            Log.lvl2('Registered user for darc::coin::credential:', darcInstances[0].id, coinInstance.id,
                credentialInstance.id);
            await contact.update();
            progress('Done', 100);
        } catch (e) {
            Log.catch(e);
            progress('Error: ' + e.toString(), -100);
            return Promise.reject(e);
        }
    }

    async createUserCredentials(pub: Public = this.keyIdentity._public,
                                darcID: Buffer = this.darcInstance.id,
                                coinIID: Buffer = this.coinInstance.id,
                                referral: Buffer = null,
                                orig: Contact = null): Promise<CredentialInstance> {
        let cred: CredentialStruct = null;
        if (orig == null) {
            Log.lvl1('Creating user credential');
            const credPub = Credential.fromNameAttr('public', 'ed25519', pub.toBuffer());
            const credDarc = Credential.fromNameAttr('darc', 'darcID', darcID);
            const credCoin = Credential.fromNameAttr('coin', 'coinIID', coinIID);
            cred = new CredentialStruct({credentials: [credPub, credDarc, credCoin]});
        } else {
            cred = orig.credential.copy();
        }
        if (referral) {
            cred.credentials[0].attributes.push(new Attribute({name: 'referred', value: referral}));
        }
        return await this.spawnerInstance.spawnCredential(this.coinInstance,
            [this.keyIdentitySigner], darcID, pub.toBuffer(), cred);
    }

    async verifyRegistration() {
        if (this.bc == null) {
            return Promise.reject('cannot verify if no byzCoin connection is set');
        }
        await this.contact.connectBC(this.bc);
    }

    // setTrustees stores the given contacts in the credential, so that a threshold of these contacts
    // can recover the darc. Only one set of contacts for recovery can be stored.
    setTrustees(threshold: number, cs: Contact[]): Promise<any> {
        if (cs.filter(c => c.isRegistered()).length !== cs.length) {
            return Promise.reject('not all contacts are registered');
        }
        const recoverBuf = Buffer.alloc(32 * cs.length);
        cs.forEach((c, i) =>
            cs[i].credentialIID.copy(recoverBuf, i * 32, 0, 32));
        this.contact.recover.trusteesBuf = recoverBuf;
        this.contact.recover.threshold = threshold;
    }

    // searchRecovery searches all contacts to know if this user is in the list of recovery possibilities.
    // It also updates all contacts by getting proofs from byzcoin.
    async searchRecovery(): Promise<Contact[]> {
        const recoveries: Contact[] = [];
        for (const contact of this.contacts) {
            await contact.update();
            if (contact.recover.trustees.filter(t =>
                t.equals(this.contact.credentialIID)).length > 0) {
                recoveries.push(contact);
            }
        }
        return recoveries;
    }

    // recoveryRequest returns a string for a qrcode that holds the new public key of the new user.
    recoveryRequest(): string {
        return sprintf('%s?public=%s', Data.urlRecoveryRequest, this.keyIdentity._public.toHex());
    }

    // RecoverySignature returns a string for a qrcode that holds the signature to be used to proof that this
    // trustee is OK with recovering a given account.
    async recoverySignature(request: string, user: Contact): Promise<string> {
        const requestObj = parseQRCode(request, 1);
        if (requestObj.url !== Data.urlRecoveryRequest) {
            return Promise.reject('not a recovery request');
        }
        if (!requestObj.public) {
            return Promise.reject('recovery request is missing public argument');
        }
        const publicKey = Buffer.from(requestObj.public, 'hex');
        if (publicKey.length !== RecoverySignature.pub) {
            return Promise.reject('got wrong public key length');
        }

        await user.update();

        // the message to be signed is:
        // credentialIID + newPublicKey + latestDarcVersion
        const msg = Buffer.alloc(RecoverySignature.msgBuf);
        user.credentialIID.copy(msg);
        publicKey.copy(msg, RecoverySignature.credIID);
        msg.writeUInt32LE(user.darcInstance.darc.version.toNumber(), RecoverySignature.credIID + RecoverySignature.pub);

        const sig = Schnorr.sign(curve, this.keyIdentity._private.scalar, new Uint8Array(msg));
        const sigBuf = Buffer.alloc(RecoverySignature.pubSig);
        this.keyIdentity._public.toBuffer().copy(sigBuf);
        Buffer.from(sig).copy(sigBuf, RecoverySignature.pub);

        return sprintf('%s?credentialIID=%s&pubSig=%s', Data.urlRecoverySignature,
            user.credentialIID.toString('hex'),
            sigBuf.toString('hex'));
    }

    /**
     * recoveryStore stores a signature for restauration. It checks if all the signature are for
     * restauration of the same credentialIID.
     *
     * @param signature the qrcode-string received from scanning.
     */
    async recoveryStore(signature: string): Promise<string> {
        const sigObj = parseQRCode(signature, 2);
        if (sigObj.url !== Data.urlRecoverySignature) {
            return Promise.reject('not a recovery signature');
        }
        if (!sigObj.credentialIID || !sigObj.pubSig) {
            return Promise.reject('credentialIID or signature missing');
        }
        const credIID = Buffer.from(sigObj.credentialIID, 'hex');
        const pubSig = Buffer.from(sigObj.pubSig, 'hex');
        if (pubSig.length !== RecoverySignature.pubSig) {
            return Promise.reject('signature should be of length 64');
        }

        if (this.recoverySignatures.length > 0) {
            if (!this.recoverySignatures[0].credentialIID.equals(credIID)) {
                this.recoverySignatures = [];
            }
        }
        this.recoverySignatures.push(new RecoverySignature(credIID, pubSig));
    }

    // recoveryUser returns the user that is currently being recovered.
    async recoveryUser(): Promise<Contact> {
        if (this.recoverySignatures.length === 0) {
            return Promise.reject('don\'t have any recovery signatures stored yet.');
        }
        return Contact.fromByzcoin(this.bc, this.recoverySignatures[0].credentialIID);
    }

    // recoverIdentity sends all received signatures to the credential instance, thus evolving the
    // darc to include our new public key.
    async recoverIdentity(): Promise<any> {
        this.contact = await this.recoveryUser();
        await this.contact.credentialInstance.recoverIdentity(this.keyIdentity._public.point, this.recoverySignatures);
        this.recoverySignatures = [];
        await this.contact.darcInstance.update();
        const newDarc = this.contact.darcInstance.darc.copy();
        ['update', 'fetch', 'transfer'].forEach(r => {
            newDarc.rules.appendToRule('invoke:' + r, this.keyIdentitySigner, '&');
        });
        await this.contact.darcInstance.evolveDarcAndWait(newDarc, [this.keyIdentitySigner], 5);
        await this.verifyRegistration();
    }

    addContact(nu: Contact) {
        this.rmContact(nu);
        this.contacts.push(nu);
    }

    rmContact(nu: Contact) {
        this.contacts = this.contacts.filter(u => !u.equals(nu));
    }

    async reloadParties(): Promise<Party[]> {
        const phrpc = new PersonhoodRPC(this.bc);
        const phParties = await phrpc.listParties();
        await Promise.all(phParties.map(async php => {
            if (this.parties.find(p => p.partyInstance.id.equals(php.instanceID)) == null) {
                Log.lvl2('Found new party id');
                const ppi = await PopPartyInstance.fromByzcoin(this.bc, php.instanceID);
                Log.lvl2('Found new party', ppi.popPartyStruct.description.name);
                const orgKeys = await ppi.fetchOrgKeys();
                const p = new Party(ppi);
                p.isOrganizer = !!orgKeys.find(k => k.equals(this.keyPersonhood._public.point));
                this.parties.push(p);
            }
        }));
        Log.lvl2('finished with searching');
        await this.save();
        return this.parties;
    }

    async updateParties(): Promise<Party[]> {
        await Promise.all(this.parties.map(async p => p.partyInstance.update()));
        // Move all finalized parties into badges
        const parties: Party[] = [];
        this.parties.forEach(p => {
            if (p.state === Party.Finalized) {
                if (p.partyInstance.popPartyStruct.attendees.keys.find(k =>
                    k.equals(this.keyPersonhood._public.point.marshalBinary()))) {
                    this.badges.push(new Badge(p, this.keyPersonhood));
                }
                Log.lvl2('removing party that doesn\'t have our key stored');
            } else {
                parties.push(p);
            }
        });
        this.parties = parties;
        await this.save();
        return this.parties;
    }

    async addParty(p: Party) {
        this.parties.push(p);
        const phrpc = new PersonhoodRPC(this.bc);
        await this.save();
        await phrpc.listParties(p.partyInstance.id);
    }

    async reloadRoPaScis(): Promise<RoPaSciInstance[]> {
        const phrpc = new PersonhoodRPC(this.bc);
        const phRoPaScis = await phrpc.listRPS();
        await Promise.all(phRoPaScis.map(async rps => {
            if (this.ropascis.find(r => r.id.equals(rps.instanceID)) == null) {
                Log.lvl2('Found new ropasci');
                const rpsInst = await RoPaSciInstance.fromByzcoin(this.bc, rps.instanceID);
                Log.lvl2('RoPaSciInstance is:', rpsInst.struct.description, rpsInst.struct.firstPlayer, rpsInst.struct.secondPlayer);
                this.ropascis.push(rpsInst);
            }
        }));
        Log.lvl2('finished with searching');
        await this.save();
        return this.ropascis;
    }

    async updateRoPaScis(): Promise<RoPaSciInstance[]> {
        await Promise.all(this.ropascis
            .filter(rps => rps.struct.firstPlayer < 0)
            .map(async rps => rps.update()));
        await this.save();
        return this.ropascis;
    }

    async addRoPaSci(rps: RoPaSciInstance) {
        this.ropascis.push(rps);
        const phrpc = new PersonhoodRPC(this.bc);
        await this.save();
        await phrpc.listRPS(rps.id);
    }

    async delRoPaSci(rps: RoPaSciInstance) {
        const i = this.ropascis.findIndex(r => r.id.equals(rps.id));
        if (i >= 0) {
            this.ropascis.splice(i, 1);
        }
        await this.save();
    }

    async reloadPolls(): Promise<PollStruct[]> {
        const phrpc = new PersonhoodRPC(this.bc);
        this.polls = await phrpc.pollList(gData.badges.map(b => b.party.partyInstance.id));
        return this.polls;
    }

    async addPoll(personhood: InstanceID, title: string, description: string, choices: string[]): Promise<PollStruct> {
        const phrpc = new PersonhoodRPC(this.bc);
        const rps = await phrpc.pollNew(personhood, title, description, choices);
        this.polls.push(rps);
        await this.save();
        return rps;
    }

    async delPoll(rps: PollStruct) {
        const i = this.polls.findIndex(r => r.pollID.equals(rps.pollID));
        if (i >= 0) {
            this.polls.splice(i, 1);
            await this.save();
        }
    }

    // createUser sets up a new user with all the necessary darcs. It does the following:
    // - creates all necessary darcs (four)
    // - creates credential and coin
    // gData needs to have enough coins to pay for all the instances when using
    // the 'SpawnerInstance'.
    async createUser(alias: string, ephemeral?: Private): Promise<Data> {
        Log.lvl1('Starting to create user', alias);
        const d = new Data();
        if (!ephemeral) {
            d.keyIdentity = new KeyPair();
        } else {
            d.keyIdentity = new KeyPair(ephemeral.toHex());
        }
        const darcDevice = Darc.newDarc([d.keyIdentitySigner], [d.keyIdentitySigner], Buffer.from('device'));
        const darcDeviceId = new IdentityDarc({id: darcDevice.getBaseID()});
        const darcSign = Darc.newDarc([darcDeviceId], [darcDeviceId], Buffer.from('signer'));
        const darcSignId = new IdentityDarc({id: darcSign.getBaseID()});
        const darcCred = Darc.newDarc([], [darcSignId], Buffer.from('credential'),
            ['invoke:' + CredentialInstance.contractID + '.update']);
        const rules = ['transfer', 'fetch', 'store'].map(inv => sprintf('invoke:%s.%s', CoinInstance.contractID, inv));
        const darcCoin = Darc.newDarc([], [darcSignId], Buffer.from('coin'), rules);

        Log.print('LTS is:', this.lts);
        const cred = Contact.prepareInitialCred(alias, d.keyIdentity._public, this.spawnerInstance.id, this.lts);

        const signers = [this.keyIdentitySigner];
        Log.lvl1('Creating identity from spawner');
        Log.lvl2('spawning darcs');
        await this.spawnerInstance.spawnDarc(this.coinInstance, signers,
            darcDevice, darcSign, darcCred, darcCoin);
        Log.lvl2('spawning coin');
        await this.spawnerInstance.spawnCoin(this.coinInstance, signers, darcCoin.getBaseID(), d.keyIdentity._public.toBuffer());
        Log.lvl2('spawning credential');
        await this.spawnerInstance.spawnCredential(this.coinInstance, signers, darcCred.getBaseID(),
            d.keyIdentity._public.toBuffer(), cred);

        d.contact = new Contact(cred, d);
        d.bc = this.bc;
        Log.lvl2('finalizing data');
        await d.connectByzcoin();
        return d;
    }

    async attachAndEvolve(ephemeral: Private): Promise<void> {
        const pub = Public.base().mul(ephemeral);
        this.contact = await Contact.fromByzcoin(this.bc, CredentialInstance.credentialIID(pub.toBuffer()));
        this.contact.data = this;
        await this.contact.connectBC(this.bc);
        this.lts = new LongTermSecret(this.bc, this.contact.ltsID, this.contact.ltsX);
        // Follow the links from the credential darc-instance to the signer-darc to the device-darc
        const signerDarcID = this.contact.darcInstance.getSignerDarcIDs()[0];
        const signerDarc = await DarcInstance.fromByzcoin(this.bc, signerDarcID);
        const deviceDarcID = signerDarc.getSignerDarcIDs()[0];
        const deviceDarc = await DarcInstance.fromByzcoin(this.bc, deviceDarcID);
        const newDeviceDarc = deviceDarc.darc.evolve();
        newDeviceDarc.rules.setRule('_sign', this.keyIdentitySigner);
        newDeviceDarc.rules.setRule('invoke:darc.evolve', this.keyIdentitySigner);
        const signer = new SignerEd25519(pub.point, ephemeral.scalar);
        await deviceDarc.evolveDarcAndWait(newDeviceDarc, [signer], 5);
    }
}

export class TestData extends Data {
    public admin: Signer;
    public darc: Darc;

    constructor(obj: {}) {
        super(obj);
    }

    static async init(r: Roster, alias: string): Promise<TestData> {
        const admin = SignerEd25519.random();
        const d = ByzCoinRPC.makeGenesisDarc([admin], r, 'genesis darc');
        ['spawn:spawner', 'spawn:coin', 'spawn:credential', 'spawn:longTermSecret', 'spawn:calypsoWrite',
            'spawn:calypsoRead',
            'invoke:coin.mint', 'invoke:coin.transfer', 'invoke:coin.fetch'].forEach(rule => {
            d.rules.appendToRule(rule, admin, '|');
        });
        const bc = await ByzCoinRPC.newByzCoinRPC(r, d, Long.fromNumber(5e8));

        const td = (await Data.createFirstUser(bc, bc.getDarc().getBaseID(), admin.secret, alias)) as TestData;
        td.admin = admin;
        td.darc = d;
        return td;
    }
}

/**
 * gData can be used as a global data in the app. However, when using it outside
 * of the UI, it is important to always pass the data, so that it is simpler to
 * test the libraries.
 */
export let gData = new Data();
