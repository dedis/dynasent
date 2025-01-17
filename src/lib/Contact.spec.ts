import {Log} from './cothority/log';
import {Data, TestData} from './Data';
import {KeyPair} from './KeyPair';
import * as Long from 'long';
import {Defaults} from './Defaults';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 100000;

describe('Contact should', async () => {
    let tdAdmin: TestData;

    beforeAll(async () => {
        Log.lvl1('Creating Byzcoin and first instance');
        tdAdmin = await TestData.init(Defaults.Roster, 'admin');
    });

    it('create an ocs and store it correctly in a new user', async () => {
        const user1 = await tdAdmin.createUser('user1');
        expect(user1.contact.ltsID).toEqual(tdAdmin.contact.ltsID);
    });

    it('create a SecureData and recover it on another user', async () => {
        const user1 = await tdAdmin.createUser('user1');
        await tdAdmin.coinInstance.transfer(Long.fromNumber(1e6), user1.coinInstance.id, [tdAdmin.keyIdentitySigner]);
        await user1.coinInstance.update();
        const user2 = await tdAdmin.createUser('user2');
        await tdAdmin.coinInstance.transfer(Long.fromNumber(1e6), user2.coinInstance.id, [tdAdmin.keyIdentitySigner]);
        await user2.coinInstance.update();
        const data = Buffer.from('very secure data');
        await user1.contact.calypso.add(data, [user2.contact.darcSignIdentity.id]);
        const sd = await user2.contact.calypso.read(user1.contact);
        expect(sd.length).toBe(1);
        expect(sd[0].plainData).toEqual(data);
    });
});
