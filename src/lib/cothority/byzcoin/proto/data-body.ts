import {Message, Properties} from 'protobufjs/light';
import {registerMessage} from '../../protobuf';
import TxResult from './tx-result';

/**
 * ByzCoin block payload
 */
export default class DataBody extends Message<DataBody> {

    constructor(props?: Properties<DataBody>) {
        super(props);

        this.txResults = this.txResults || [];

        /* Protobuf aliases */

        Object.defineProperty(this, 'txresults', {
            get(): TxResult[] {
                return this.txResults;
            },
            set(value: TxResult[]) {
                this.txResults = value;
            },
        });
    }

    readonly txResults: TxResult[];
    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('byzcoin.DataBody', DataBody, TxResult);
    }
}

DataBody.register();
