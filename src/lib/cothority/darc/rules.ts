import {Message, Properties} from 'protobufjs/light';
import {EMPTY_BUFFER, registerMessage} from '../protobuf';
import {IIdentity} from './identity-wrapper';

/**
 * A rule will give who is allowed to use a given action
 */
export class Rule extends Message<Rule> {

    readonly action: string;
    readonly expr: Buffer;

    constructor(props?: Properties<Rule>) {
        super(props);

        this.expr = Buffer.from(this.expr || EMPTY_BUFFER);
    }

    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('Rule', Rule);
    }

    /**
     * Get a deep clone of the rule
     * @returns the new rule
     */
    clone(): Rule {
        return new Rule({
            action: this.action,
            expr: Buffer.from(this.expr),
        });
    }

    /**
     * Get a string representation of the rule
     * @returns the string representation
     */
    toString(): string {
        return this.action + ' - ' + this.expr.toString();
    }
}

/**
 * Wrapper around a list of rules that provides helpers to manage
 * the rules
 */
export default class Rules extends Message<Rules> {

    static OR = '|';
    static AND = '&';
    readonly list: Rule[];

    constructor(properties?: Properties<Rules>) {
        super(properties);

        if (!properties || !this.list) {
            this.list = [];
        }
    }

    /**
     * @see README#Message classes
     */
    static register() {
        registerMessage('Rules', Rules, Rule);
    }

    /**
     * Create or update a rule with the given identity
     * @param action    the name of the rule
     * @param identity  the identity to append
     * @param op        the operator to use if the rule exists
     */
    appendToRule(action: string, identity: IIdentity, op: string): void {
        const idx = this.list.findIndex((r) => r.action === action);

        if (idx >= 0) {
            const rule = this.list[idx];
            this.list[idx] = new Rule({
                action: rule.action,
                expr: Buffer.concat([rule.expr, Buffer.from(` ${op} ${identity.toString()}`)]),
            });
        } else {
            this.list.push(new Rule({action, expr: Buffer.from(identity.toString())}));
        }
    }

    /**
     * Sets a rule to correspond to the given identity. If the rule already exists, it will be
     * replaced.
     * @param action    the name of the rule
     * @param identity  the identity to append
     */
    setRule(action: string, identity: IIdentity): void {
        const idx = this.list.findIndex((r) => r.action === action);

        const r = new Rule({action, expr: Buffer.from(identity.toString())});
        if (idx >= 0) {
            this.list[idx] = r;
        } else {
            this.list.push(r);
        }
    }

    /**
     * getRule returns the rule with the given action
     *
     * @param action to search in the rules for.
     */
    getRule(action: string): Rule {
        return this.list.find(r => r.action === action);
    }

    /**
     * Get a deep copy of the list of rules
     * @returns the clone
     */
    clone(): Rules {
        return new Rules({list: this.list.map((r) => r.clone())});
    }

    /**
     * Get a string representation of the rules
     * @returns a string representation
     */
    toString(): string {
        return this.list.map((l) => l.toString()).join('\n');
    }
}

Rule.register();
Rules.register();
