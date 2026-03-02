import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    Revert,
    SafeMath,
encodeSelector,
} from '@btc-vision/btc-runtime/runtime';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';

// =============================================================================
// Storage Pointer Allocation
// =============================================================================
const stakedBalancePointer: u16 = Blockchain.nextPointer;
const rewardDebtPointer: u16 = Blockchain.nextPointer;
const cooldownAmountPointer: u16 = Blockchain.nextPointer;
const cooldownUnlockBlockPointer: u16 = Blockchain.nextPointer;
const totalStakedPointer: u16 = Blockchain.nextPointer;
const accRewardPerSharePointer: u16 = Blockchain.nextPointer;
const lastRewardBlockPointer: u16 = Blockchain.nextPointer;
const rewardRatePointer: u16 = Blockchain.nextPointer;
const rewardReservePointer: u16 = Blockchain.nextPointer;
const ownerPointer: u16 = Blockchain.nextPointer;
const stakeTokenPointer: u16 = Blockchain.nextPointer;
const rewardTokenPointer: u16 = Blockchain.nextPointer;

// ~7 days at ~10 min/block
const COOLDOWN_BLOCKS: u64 = 1008;

// Storage key for global values
const GLOBAL_KEY: u256 = u256.Zero;

@final
export class StakingContract extends OP_NET {

    // Per-user maps
    private readonly stakedBalance: StoredMapU256;
    private readonly rewardDebt: StoredMapU256;
    private readonly cooldownAmount: StoredMapU256;
    private readonly cooldownUnlockBlock: StoredMapU256;

    // Global state (stored in maps keyed by GLOBAL_KEY)
    private readonly totalStakedMap: StoredMapU256;
    private readonly accRewardPerShareMap: StoredMapU256;
    private readonly lastRewardBlockMap: StoredMapU256;
    private readonly rewardRateMap: StoredMapU256;
    private readonly rewardReserveMap: StoredMapU256;
    private readonly ownerMap: StoredMapU256;
    private readonly stakeTokenMap: StoredMapU256;
    private readonly rewardTokenMap: StoredMapU256;

    public constructor() {
        super();
        this.stakedBalance = new StoredMapU256(stakedBalancePointer);
        this.rewardDebt = new StoredMapU256(rewardDebtPointer);
        this.cooldownAmount = new StoredMapU256(cooldownAmountPointer);
        this.cooldownUnlockBlock = new StoredMapU256(cooldownUnlockBlockPointer);
        this.totalStakedMap = new StoredMapU256(totalStakedPointer);
        this.accRewardPerShareMap = new StoredMapU256(accRewardPerSharePointer);
        this.lastRewardBlockMap = new StoredMapU256(lastRewardBlockPointer);
        this.rewardRateMap = new StoredMapU256(rewardRatePointer);
        this.rewardReserveMap = new StoredMapU256(rewardReservePointer);
        this.ownerMap = new StoredMapU256(ownerPointer);
        this.stakeTokenMap = new StoredMapU256(stakeTokenPointer);
        this.rewardTokenMap = new StoredMapU256(rewardTokenPointer);
    }

    // ─── Deployment ───────────────────────────────────────────────────────────

    public override onDeployment(calldata: Calldata): void {
        const stakeToken = calldata.readAddress();
        const rewardToken = calldata.readAddress();
        const initialRate = calldata.readU256();

        this.stakeTokenMap.set(GLOBAL_KEY, this._addressToU256(stakeToken));
        this.rewardTokenMap.set(GLOBAL_KEY, this._addressToU256(rewardToken));
        this.ownerMap.set(GLOBAL_KEY, this._addressToU256(Blockchain.tx.origin));
        this.rewardRateMap.set(GLOBAL_KEY, initialRate);
        this.lastRewardBlockMap.set(GLOBAL_KEY, u256.fromU64(Blockchain.block.number));
    }

    // ─── Stake ────────────────────────────────────────────────────────────────

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'newStake', type: ABIDataTypes.UINT256 })
    public stake(calldata: Calldata): BytesWriter {
        const amount = calldata.readU256();
        if (amount.isZero()) throw new Revert('Amount must be > 0');

        const user = Blockchain.tx.sender;
        const userKey = this._addressToU256(user);

        this._callTransferFrom(
            this._u256ToAddress(this.stakeTokenMap.get(GLOBAL_KEY)),
            user,
            Blockchain.contractAddress,
            amount,
        );

        this._updatePool();

        const userStake = this.stakedBalance.get(userKey);
        if (!userStake.isZero()) {
            const pending = this._calcPending(userKey, userStake);
            if (!pending.isZero()) this._sendRewards(user, pending);
        }

        const newStake = SafeMath.add(userStake, amount);
        this.stakedBalance.set(userKey, newStake);

        const acc = this.accRewardPerShareMap.get(GLOBAL_KEY);
        const newDebt = SafeMath.div(SafeMath.mul(newStake, acc), this._precision());
        this.rewardDebt.set(userKey, newDebt);

        this.totalStakedMap.set(GLOBAL_KEY, SafeMath.add(this.totalStakedMap.get(GLOBAL_KEY), amount));

        const writer = new BytesWriter(32);
        writer.writeU256(newStake);
        return writer;
    }

    // ─── Initiate Unstake ─────────────────────────────────────────────────────

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'unlockBlock', type: ABIDataTypes.UINT64 })
    public initiateUnstake(calldata: Calldata): BytesWriter {
        const amount = calldata.readU256();
        if (amount.isZero()) throw new Revert('Amount must be > 0');

        const user = Blockchain.tx.sender;
        const userKey = this._addressToU256(user);
        const userStake = this.stakedBalance.get(userKey);

        if (u256.lt(userStake, amount)) throw new Revert('Insufficient staked balance');
        if (!this.cooldownAmount.get(userKey).isZero()) throw new Revert('Cooldown already in progress');

        this._updatePool();

        const pending = this._calcPending(userKey, userStake);
        if (!pending.isZero()) this._sendRewards(user, pending);

        const newStake = SafeMath.sub(userStake, amount);
        this.stakedBalance.set(userKey, newStake);
        this.totalStakedMap.set(GLOBAL_KEY, SafeMath.sub(this.totalStakedMap.get(GLOBAL_KEY), amount));

        const acc = this.accRewardPerShareMap.get(GLOBAL_KEY);
        const newDebt = SafeMath.div(SafeMath.mul(newStake, acc), this._precision());
        this.rewardDebt.set(userKey, newDebt);

        const unlockBlock: u64 = Blockchain.block.number + COOLDOWN_BLOCKS;
        this.cooldownAmount.set(userKey, amount);
        this.cooldownUnlockBlock.set(userKey, u256.fromU64(unlockBlock));

        const writer = new BytesWriter(8);
        writer.writeU64(unlockBlock);
        return writer;
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public withdraw(_: Calldata): BytesWriter {
        const user = Blockchain.tx.sender;
        const userKey = this._addressToU256(user);

        const cooldownAmt = this.cooldownAmount.get(userKey);
        if (cooldownAmt.isZero()) throw new Revert('No pending withdrawal');

        const unlockBlock = this.cooldownUnlockBlock.get(userKey).toU64();
        if (Blockchain.block.number < unlockBlock) throw new Revert('Cooldown not elapsed');

        this.cooldownAmount.set(userKey, u256.Zero);
        this.cooldownUnlockBlock.set(userKey, u256.Zero);

        this._callTransfer(
            this._u256ToAddress(this.stakeTokenMap.get(GLOBAL_KEY)),
            user,
            cooldownAmt,
        );

        const writer = new BytesWriter(32);
        writer.writeU256(cooldownAmt);
        return writer;
    }

    // ─── Claim Rewards ────────────────────────────────────────────────────────

    @method()
    @returns({ name: 'claimed', type: ABIDataTypes.UINT256 })
    public claimRewards(_: Calldata): BytesWriter {
        const user = Blockchain.tx.sender;
        const userKey = this._addressToU256(user);
        const userStake = this.stakedBalance.get(userKey);

        if (userStake.isZero()) throw new Revert('Nothing staked');

        this._updatePool();

        const pending = this._calcPending(userKey, userStake);
        if (pending.isZero()) throw new Revert('No rewards to claim');

        this._sendRewards(user, pending);

        const acc = this.accRewardPerShareMap.get(GLOBAL_KEY);
        const newDebt = SafeMath.div(SafeMath.mul(userStake, acc), this._precision());
        this.rewardDebt.set(userKey, newDebt);

        const writer = new BytesWriter(32);
        writer.writeU256(pending);
        return writer;
    }

    // ─── Fund Rewards (Owner) ─────────────────────────────────────────────────

    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'newReserve', type: ABIDataTypes.UINT256 })
    public fundRewards(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        const amount = calldata.readU256();
        if (amount.isZero()) throw new Revert('Amount must be > 0');

        this._callTransferFrom(
            this._u256ToAddress(this.rewardTokenMap.get(GLOBAL_KEY)),
            Blockchain.tx.sender,
            Blockchain.contractAddress,
            amount,
        );

        const newReserve = SafeMath.add(this.rewardReserveMap.get(GLOBAL_KEY), amount);
        this.rewardReserveMap.set(GLOBAL_KEY, newReserve);

        const writer = new BytesWriter(32);
        writer.writeU256(newReserve);
        return writer;
    }

    // ─── Set Reward Rate (Owner) ───────────────────────────────────────────────

    @method({ name: 'newRate', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setRewardRate(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this._updatePool();
        this.rewardRateMap.set(GLOBAL_KEY, calldata.readU256());

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ─── View: Pending Rewards ────────────────────────────────────────────────

    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'pending', type: ABIDataTypes.UINT256 })
    public pendingRewards(calldata: Calldata): BytesWriter {
        const user = calldata.readAddress();
        const userKey = this._addressToU256(user);
        const userStake = this.stakedBalance.get(userKey);

        let simAcc = this.accRewardPerShareMap.get(GLOBAL_KEY);
        const totalS = this.totalStakedMap.get(GLOBAL_KEY);
        const currentBlock = Blockchain.block.number;
        const lastBlock = this.lastRewardBlockMap.get(GLOBAL_KEY).toU64();

        if (currentBlock > lastBlock && !totalS.isZero()) {
            const blocks = u256.fromU64(currentBlock - lastBlock);
            const reward = SafeMath.mul(blocks, this.rewardRateMap.get(GLOBAL_KEY));
            const reserve = this.rewardReserveMap.get(GLOBAL_KEY);
            const actualReward = u256.lt(reward, reserve) ? reward : reserve;
            simAcc = SafeMath.add(simAcc, SafeMath.div(SafeMath.mul(actualReward, this._precision()), totalS));
        }

        const debt = this.rewardDebt.get(userKey);
        const earned = SafeMath.div(SafeMath.mul(userStake, simAcc), this._precision());
        const pending = u256.lt(earned, debt) ? u256.Zero : SafeMath.sub(earned, debt);

        const writer = new BytesWriter(32);
        writer.writeU256(pending);
        return writer;
    }

    // ─── View: Stake Info ─────────────────────────────────────────────────────

    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'staked', type: ABIDataTypes.UINT256 },
        { name: 'cooldownAmt', type: ABIDataTypes.UINT256 },
        { name: 'cooldownUnlockBlock', type: ABIDataTypes.UINT64 },
    )
    public getStakeInfo(calldata: Calldata): BytesWriter {
        const user = calldata.readAddress();
        const userKey = this._addressToU256(user);

        const writer = new BytesWriter(72);
        writer.writeU256(this.stakedBalance.get(userKey));
        writer.writeU256(this.cooldownAmount.get(userKey));
        writer.writeU64(this.cooldownUnlockBlock.get(userKey).toU64());
        return writer;
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    private _precision(): u256 {
        // 1e18
        return u256.fromU64(1_000_000_000_000_000_000);
    }

    private _updatePool(): void {
        const currentBlock = Blockchain.block.number;
        const lastBlock = this.lastRewardBlockMap.get(GLOBAL_KEY).toU64();
        if (currentBlock <= lastBlock) return;

        const totalS = this.totalStakedMap.get(GLOBAL_KEY);
        if (totalS.isZero()) {
            this.lastRewardBlockMap.set(GLOBAL_KEY, u256.fromU64(currentBlock));
            return;
        }

        const blocks = u256.fromU64(currentBlock - lastBlock);
        const reward = SafeMath.mul(blocks, this.rewardRateMap.get(GLOBAL_KEY));
        const reserve = this.rewardReserveMap.get(GLOBAL_KEY);
        const actualReward = u256.lt(reward, reserve) ? reward : reserve;

        if (!actualReward.isZero()) {
            const addAcc = SafeMath.div(SafeMath.mul(actualReward, this._precision()), totalS);
            this.accRewardPerShareMap.set(GLOBAL_KEY, SafeMath.add(this.accRewardPerShareMap.get(GLOBAL_KEY), addAcc));
            this.rewardReserveMap.set(GLOBAL_KEY, SafeMath.sub(reserve, actualReward));
        }

        this.lastRewardBlockMap.set(GLOBAL_KEY, u256.fromU64(currentBlock));
    }

    private _calcPending(userKey: u256, userStake: u256): u256 {
        const debt = this.rewardDebt.get(userKey);
        const earned = SafeMath.div(SafeMath.mul(userStake, this.accRewardPerShareMap.get(GLOBAL_KEY)), this._precision());
        return u256.lt(earned, debt) ? u256.Zero : SafeMath.sub(earned, debt);
    }

    private _sendRewards(to: Address, amount: u256): void {
        if (amount.isZero()) return;
        this._callTransfer(this._u256ToAddress(this.rewardTokenMap.get(GLOBAL_KEY)), to, amount);
    }

   private _callTransfer(token: Address, to: Address, amount: u256): void {
    const cd = new BytesWriter(68);
    cd.writeSelector(0x3b88ef57);
    cd.writeAddress(to);
    cd.writeU256(amount);
    Blockchain.call(token, cd);
}

private _callTransferFrom(token: Address, from: Address, to: Address, amount: u256): void {
    const cd = new BytesWriter(100);
    cd.writeSelector(0x4b6685e7);
    cd.writeAddress(from);
    cd.writeAddress(to);
    cd.writeU256(amount);
    Blockchain.call(token, cd);
}

    private _onlyOwner(): void {
        const owner = this._u256ToAddress(this.ownerMap.get(GLOBAL_KEY));
        if (!Blockchain.tx.sender.equals(owner)) throw new Revert('Not owner');
    }

    protected _addressToU256(addr: Address): u256 {
        return u256.fromUint8ArrayBE(addr);
    }

    protected _u256ToAddress(val: u256): Address {
        if (val.isZero()) return Address.zero();
        return Address.fromUint8Array(val.toUint8Array(true));
    }@method({ name: 'amount', type: ABIDataTypes.UINT256 })
@returns()
public compound(_calldata: Calldata): BytesWriter {
    const caller = Blockchain.tx.sender;
    const callerKey = this._addressToU256(caller);

    const userStake = this.stakedBalance.get(callerKey);
    if (userStake.isZero()) throw new Revert('Nothing staked');

    this._updatePool();

    const accRPS = this.accRewardPerShareMap.get(u256.Zero);
    const PRECISION = this._precision();
    const debt = this.rewardDebt.get(callerKey);
    const pending = SafeMath.sub(
        SafeMath.div(SafeMath.mul(userStake, accRPS), PRECISION),
        debt
    );

    if (pending.isZero()) throw new Revert('No rewards to compound');

    const reserve = this.rewardReserveMap.get(u256.Zero);
    if (u256.lt(reserve, pending)) throw new Revert('Insufficient reward reserve');

    this.rewardReserveMap.set(u256.Zero, SafeMath.sub(reserve, pending));

    const newStake = SafeMath.add(userStake, pending);
    this.stakedBalance.set(callerKey, newStake);
    this.rewardDebt.set(callerKey, SafeMath.div(SafeMath.mul(newStake, accRPS), PRECISION));
    this.totalStakedMap.set(u256.Zero, SafeMath.add(this.totalStakedMap.get(u256.Zero), pending));

    return new BytesWriter(0);
}
}
