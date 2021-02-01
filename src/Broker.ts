import {BrokerHub, CreateSubOrder, isSwapOrder, SubOrderStatus, SubOrderStatusAccepted} from './hub/BrokerHub';
import {Db} from './db/Db';
import {log} from './log';
import {
    Balances,
    BlockchainOrder,
    Dictionary,
    Liability,
    OrderType,
    SendOrder,
    Side,
    Status,
    SubOrder,
    Trade,
    Transaction,
    Withdraw
} from './Model';
import BigNumber from 'bignumber.js';
import {WebUI} from './ui/WebUI';
import {Connectors, ExchangeResolve} from './connectors/Connectors';
import {fromWei8, OrionBlockchain} from './OrionBlockchain';
import {Settings} from './Settings';
import {Connector, ExchangeWithdrawLimit, ExchangeWithdrawStatus} from './connectors/Connector';

export class Broker {
    settings: Settings;
    brokerHub: BrokerHub;
    db: Db;
    webUI: WebUI;
    connector: Connectors;
    orionBlockchain: OrionBlockchain;
    lastBalances: Dictionary<Dictionary<BigNumber>> = {};

    private balanceInterval: NodeJS.Timeout;
    private checkSubOrdersInterval: NodeJS.Timeout;
    private checkWithdrawsInterval: NodeJS.Timeout;
    private checkTransactionsInterval: NodeJS.Timeout;
    private checkLiabilitiesInterval: NodeJS.Timeout;

    constructor(settings: Settings, brokerHub: BrokerHub, db: Db, webUI: WebUI, connector: Connectors) {
        this.settings = settings;
        this.brokerHub = brokerHub;
        this.db = db;
        this.webUI = webUI;
        this.connector = connector;

        brokerHub.onCreateSubOrder = this.onCreateSubOrder.bind(this);
        brokerHub.onCancelSubOrder = this.onCancelSubOrder.bind(this);
        brokerHub.onCheckSubOrder = this.onCheckSubOrder.bind(this);
        brokerHub.onSubOrderStatusAccepted = this.onSubOrderStatusAccepted.bind(this);
        brokerHub.onReconnect = this.connectToAggregator.bind(this);
    }

    async onSubOrderStatusAccepted(data: SubOrderStatusAccepted): Promise<void> {
        const id = data.id;

        const dbSubOrder: SubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) {
            throw new Error(`Suborder ${id} not found`);
        }

        const rejectedByAggregator = (data.status === Status.REJECTED) && (dbSubOrder.status !== Status.REJECTED);
        if (rejectedByAggregator) {
            dbSubOrder.status = Status.REJECTED;
            log.error(`Order ${id} rejected by aggregator`);
        }

        const isStatusFinal = dbSubOrder.status !== Status.PREPARE && dbSubOrder.status !== Status.ACCEPTED;
        if (rejectedByAggregator || (dbSubOrder.status === data.status && isStatusFinal)) {
            dbSubOrder.sentToAggregator = true;
            await this.db.updateSubOrder(dbSubOrder);
            this.webUI.sendToFrontend(dbSubOrder);
        }
    };

    async onCheckSubOrder(id: number): Promise<SubOrderStatus> {
        const dbSubOrder: SubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) {
            return {
                id: id,
                status: null,
                filledAmount: '0'
            };
        }

        // const
        //     // trades: Trade[] = dbSubOrder.exchangeOrderId ? (await this.db.getSubOrderTrades(dbSubOrder.exchange, dbSubOrder.exchangeOrderId)) : [],
        //     traderAmount = dbSubOrder.filledAmount.multipliedBy(dbSubOrder.price),
        //     amount = dbSubOrder.type === OrderType.SUB ? dbSubOrder.trades[0].amount : traderAmount;
        // ;

        if (dbSubOrder.trades.length > 1 && dbSubOrder.orderType === OrderType.SUB) {
            throw new Error('Cant support multiple trades yet ' + dbSubOrder.id);
        }

        const blockchainOrder: BlockchainOrder = dbSubOrder.trades.length === 0 ? undefined : (await this.orionBlockchain.signTrade(dbSubOrder, dbSubOrder.trades[0]));

        return {
            id: id,
            status: dbSubOrder.status === Status.PREPARE ? Status.ACCEPTED : dbSubOrder.status,
            filledAmount: dbSubOrder.filledAmount.toString(),
            blockchainOrder: blockchainOrder
        };
    }

    async onCreateSubOrder(request: CreateSubOrder): Promise<SubOrderStatus> {
        const oldSubOrder = await this.db.getSubOrderById(request.id);

        if (oldSubOrder) {
            log.log('Suborder ' + request.id + ' already created');
            return this.onCheckSubOrder(request.id);
        }

        const
            isSwap = isSwapOrder(request),
            dbSubOrder = new SubOrder(),
            reqSymbol = request.symbol || request.pair,
            [srcAsset, dstAsset]: string[] = reqSymbol.split('-'),
            symbol: string = [srcAsset, isSwap ? 'USDT' : dstAsset].join('-'),
            symbolAlias: string = this.symbolAlias(symbol, dbSubOrder.exchange),
            amount: BigNumber = dbSubOrder.amount,
            price: BigNumber = isSwap ? dbSubOrder.sellPrice : dbSubOrder.price,
            side: Side = isSwap ? 'sell' : dbSubOrder.side,
            allBalances = await this.connector.getBalances(),
            targetBalances: ExchangeResolve<Balances> = allBalances[request.exchange],
            {result: balances} = targetBalances,
            srcBalance: BigNumber = balances[srcAsset]
        ;

        if (srcBalance.isZero() && isSwap) {
            return {
                id: request.id,
                status: Status.CANCELED,
                filledAmount: '0'
            };
        }


        Object.assign(dbSubOrder, {
            id: request.id,
            symbol: reqSymbol,
            side: request.side,
            price: request.price,
            amount: request.amount,
            exchange: request.exchange,
            timestamp: Date.now(),
            status: Status.PREPARE,
            orderType: isSwap ? OrderType.SWAP : OrderType.SUB,
            filledAmount: new BigNumber(0),
            sentToAggregator: false,
            ...isSwap ? {
                currentDiv: request.currentDiv,
                sellPrice: request.sellPrice,
                buyPrice: request.sellPrice
            } : null
        });

        await this.db.insertSubOrder(dbSubOrder);
        log.debug(`Suborder ${request.id} inserted`);

        let sendOrder: SendOrder = null;

        try {
            sendOrder = await this.connector.submitSubOrder(dbSubOrder.exchange, dbSubOrder.id, symbolAlias, dbSubOrder.side, amount, price);
        } catch (e) {
            log.error('Submit order error:', e);
        }

        if (sendOrder === null) {
            dbSubOrder.status = Status.REJECTED;
        } else {
            dbSubOrder.exchangeOrderId = sendOrder.exchangeOrderId;
            dbSubOrder.status = Status.ACCEPTED;
            const trade: Trade = new Trade();
            trade.exchange = dbSubOrder.exchange;
            trade.exchangeOrderId = sendOrder.exchangeOrderId;
            trade.order = dbSubOrder;
            trade.symbol = symbol;
            trade.symbolAlias = symbolAlias;
            trade.price = price;
            trade.amount = amount;
            trade.side = side;
            trade.timestamp = sendOrder.timestamp;
            trade.type = 'limit';
            trade.status = 'pending';
            await this.db.insertTrade(trade);
        }

        await this.db.updateSubOrder(dbSubOrder);
        log.debug('Suborder updated ', JSON.stringify(dbSubOrder));

        this.webUI.sendToFrontend(dbSubOrder);
        return this.onCheckSubOrder(dbSubOrder.id);
    };

    symbolAlias(symbol: string, exchangeId: string): string {
        const
            exchange = this.settings.exchanges[exchangeId],
            symbolAliases = exchange && exchange['aliases'] ? exchange['aliases'] : {}
        ;
        return symbolAliases[symbol] ? symbolAliases[symbol] : symbol;
    }

    async onCancelSubOrder(id: number): Promise<SubOrderStatus | null> {
        const dbSubOrder: SubOrder = await this.db.getSubOrderById(id);

        if (!dbSubOrder) throw new Error('Cant find suborder ' + dbSubOrder.id);

        if (dbSubOrder.status === Status.PREPARE) {
            // todo: implement cancel order in prepare status
            return null;
        } else if (dbSubOrder.status === Status.ACCEPTED) {
            await this.connector.cancelSubOrder(dbSubOrder);
            // NOTE: this suborder will be send to broker hub in next checkSubOrders
            return null;
        } else {
            log.log('Cant cancel suborder in status ' + dbSubOrder.status);
            return this.onCheckSubOrder(dbSubOrder.id);
        }
    };

    sendUpdateBalance(balances: Dictionary<ExchangeResolve<Balances>>): Promise<void> {
        const exchanges: Dictionary<Dictionary<string>> = {};
        this.lastBalances = {};

        for (const exchange in balances) {
            const exchangeBalances: ExchangeResolve<Balances> = balances[exchange];
            if (exchangeBalances.error) {
                log.error('Get ' + exchange + ' balances error:', exchangeBalances.error);
            } else {
                this.lastBalances[exchange] = {};
                exchanges[exchange] = {};
                for (const currency in exchangeBalances.result) {
                    const v = exchangeBalances.result[currency];
                    exchanges[exchange][currency] = v.toString();
                    this.lastBalances[exchange][currency] = v;
                }
            }
        }
        const newBalancesJson = JSON.stringify(exchanges);
        if (this.brokerHub.getLastBalancesJson() !== newBalancesJson) {
            this.webUI.lastBalancesJson = newBalancesJson;
            return this.brokerHub.sendBalances(exchanges);
        }
    }

    startUpdateBalances(): void {
        this.balanceInterval = setInterval(async () => {
            try {
                const balances = await this.connector.getBalances();
                await this.sendUpdateBalance(balances);
            } catch (e) {
                log.error('Get balances error:', e);
            }
        }, 10 * 1000);
    }

    startCheckSubOrders(): void {
        this.checkSubOrdersInterval = setInterval(async () => {
            try {
                const subOrdersToResend = await this.db.getSubOrdersToResend();
                for (const subOrder of subOrdersToResend) {
                    await this.brokerHub.sendSubOrderStatus(await this.onCheckSubOrder(subOrder.id));
                }

                // const openSubOrders = await this.db.getSubOrdersToCheck();
                // if (openSubOrders.length) {
                //     await this.connector.checkSubOrders(openSubOrders);
                // }
                const pendingTrades = await this.db.getTradesToCheck();
                if (pendingTrades.length) {
                    await this.connector.checkTrades(pendingTrades);
                }
            } catch (e) {
                log.error('Suborders check error:', e);
            }
        }, 10 * 1000);
    }

    startCheckWithdraws(): void {
        this.checkWithdrawsInterval = setInterval(async () => {
            try {
                const openWithdraws = await this.db.getWithdrawsToCheck();
                if (openWithdraws.length) {
                    const withdrawsStatuses: ExchangeWithdrawStatus[] = await this.connector.checkWithdraws(openWithdraws);
                    for (const status of withdrawsStatuses) {
                        const w = openWithdraws.find(w => w.exchangeWithdrawId === status.exchangeWithdrawId);
                        log.log('Withdraw ' + w.amount.toString() + ' ' + w.currency + ' from ' + w.exchange + ' status ' + status.status);
                        await this.db.updateWithdrawStatus(status.exchangeWithdrawId, status.status);
                    }
                }
            } catch (e) {
                log.error('Withdraw check error:', e);
            }
        }, 60 * 1000);
    }

    startCheckTransactions(): void {
        this.checkTransactionsInterval = setInterval(async () => {
            try {
                const pendingTransactions: Transaction[] = await this.db.getPendingTransactions();
                for (const tx of pendingTransactions) {
                    let status = await this.orionBlockchain.getTransactionStatus(tx.transactionHash);
                    if (status === 'NONE' && (Date.now() - tx.createTime > 10 * 60 * 1000)) { // 10 min
                        status = 'FAIL';
                    }
                    if (status !== tx.status) {
                        if (status === 'OK' || status === 'FAIL') {
                            await this.db.updateTransactionStatus(tx.transactionHash, status);
                            log.log('Tx ' + tx.method + ' ' + tx.amount.toString() + ' ' + tx.asset + ' ' + status);
                        }
                    }
                }
            } catch (e) {
                log.error('Transactions check error:', e);
            }
        }, 10 * 1000);
    }

    async manageLiability(liability: Liability): Promise<void> {
        const now = Date.now() / 1000;
        if (liability.outstandingAmount.gt(0) && (now - liability.timestamp > this.settings.duePeriodSeconds)) {
            const assetName = liability.assetName;
            const amount: BigNumber = fromWei8(liability.outstandingAmount);

            if ((await this.db.getPendingTransactions()).length) {
                return;
            }
            if ((await this.db.getWithdrawsToCheck()).length) {
                return;
            }

            log.log('Detected outstanding ' + amount.toString() + ' ' + assetName);

            const balance = await this.orionBlockchain.getWalletBalance();
            let assetBalance = balance[assetName];
            const ethBalance = balance['ETH'];

            if (!assetBalance || assetBalance.isNaN()) throw new Error('No balance for ' + assetName);
            if (!ethBalance || ethBalance.isNaN()) throw new Error('No balance for ETH');

            const ethFeeAmount = new BigNumber(0.045); // todo: gas fee hardcode 300 gwei * 1e-9 * 150000 (DEPOSIT_ERC20_GAS_LIMIT)
            if (!ethBalance.gt(ethFeeAmount)) {
                log.log('No ' + ethFeeAmount.toString() + ' ETH for gas on wallet');
                return;
            }

            if (assetName === 'ETH') {
                assetBalance = assetBalance.minus(ethFeeAmount);
            }

            const fitBalance = assetBalance.gte(amount);

            if (fitBalance) {
                // todo: если тут слишком малая сумма, то выгоднее отправить сразу больше
                await this.deposit(amount, assetName);
            } else {
                const remaining = amount.minus(assetBalance);
                const exchangeForWithdraw = await this.getExchangeForWithdraw(remaining, assetName);
                if (exchangeForWithdraw) {
                    const {exchange, amountWithFee} = exchangeForWithdraw;
                    // NOTE: мы снимаем remainingWithFee так как большинство бирж вычитают свою комиссию из переданного амаунта
                    await this.exchangeWithdraw(exchange, amountWithFee, assetName);
                } else {
                    log.log(`Need to make ${amount.toString()} ${assetName} deposit to orion contract but there is not enough amount on the wallet and exchanges`);
                }
            }
        }
    }

    startCheckLiabilities(): void {
        this.checkLiabilitiesInterval = setInterval(async () => {
            try {
                const liabilities: Liability[] = await this.orionBlockchain.getLiabilities();
                for (const l of liabilities) {
                    await this.manageLiability(l);
                }
            } catch (e) {
                log.error('Liabilities check error:', e);
            }
        }, 5 * 60 * 1000);
    }

    async connectToAggregator(): Promise<void> {
        try {
            const time = Date.now();
            const signature = await this.orionBlockchain.sign(time.toString());
            await this.brokerHub.connect({address: this.orionBlockchain.address, time, signature});
        } catch (e) {
            log.error('Failed to connect to aggregator:', e);
        }
    }

    async connectToOrion(): Promise<void> {
        clearInterval(this.balanceInterval);
        clearInterval(this.checkSubOrdersInterval);
        clearInterval(this.checkWithdrawsInterval);
        clearInterval(this.checkTransactionsInterval);
        clearInterval(this.checkLiabilitiesInterval);
        if (this.settings.privateKey) {
            this.orionBlockchain = new OrionBlockchain(this.settings);
            await this.orionBlockchain.initContracts();
            await this.connectToAggregator();
            this.startUpdateBalances();
            this.startCheckSubOrders();
            this.startCheckWithdraws();
            this.startCheckLiabilities();
            this.startCheckTransactions();
        }
    }

    // TRADE

    async onTrade(trade: Trade): Promise<void> {
        try {
            const dbSubOrder: SubOrder = await this.db.getSubOrder(trade.exchange, trade.exchangeOrderId);

            if (!dbSubOrder) {
                throw new Error(`Suborder ${trade.exchangeOrderId} in ${trade.exchange} not found`);
            }

            if (trade.status !== 'ok' && trade.status !== 'canceled') {
                throw new Error('Unexpected trade status ' + trade.status);
            }

            // if (trade.status === Status.FILLED && !dbSubOrder.amount.eq(trade.amount)) {
            //     throw new Error('Partially trade not supported yet ' + dbSubOrder.id);
            // }
            //
            // dbSubOrder.filledAmount = trade.amount;
            // dbSubOrder.status = trade.status;
            //
            // if (dbSubOrder.filledAmount.gt(0)) {
            //     await this.db.insertTrade(trade); // todo: insertTrade & updateSubOrder in transaction
            // }
            // await this.db.updateSubOrder(dbSubOrder);

            dbSubOrder.orderType === OrderType.SUB ? await this.processSubOrderTrade(dbSubOrder, trade) : await this.processSwapOrderTrade(dbSubOrder, trade);

            log.log('Send suborder ' + dbSubOrder.id + ' ' + trade.status + ' status: ' + dbSubOrder.side + ' ' + dbSubOrder.filledAmount + ' ' + dbSubOrder.symbol + ' on ' + dbSubOrder.exchange);

            log.debug('onTrade', dbSubOrder);

            await this.brokerHub.sendSubOrderStatus(await this.onCheckSubOrder(dbSubOrder.id));
            this.webUI.sendToFrontend(dbSubOrder);
        } catch (e) {
            log.error('Trade error:', e);
        }
    }

    async processSubOrderTrade(dbSubOrder: SubOrder, trade: Trade): Promise<void> {
        if (!dbSubOrder.amount.eq(trade.amount)) {
            throw new Error('Partially trade not supported yet ' + dbSubOrder.id);
        }

        // const [upTrade] = dbSubOrder.trades.slice(-1);


        // upTrade.amount = trade.amount;
        // upTrade.price = trade.price;
        trade.status = 'ok';

        dbSubOrder.filledAmount = trade.amount;
        dbSubOrder.status = Status.FILLED;

        const transaction = await this.db.getTransactionManager();

        await transaction.save(trade);
        await transaction.save(dbSubOrder);


    }

    async processSwapOrderTrade(dbSubOrder: SubOrder, trade: Trade) {
        const
            // upTrade = dbSubOrder.trades.find( (orderTrade: Trade) => orderTrade.exchange === trade.exchange && orderTrade.exchangeOrderId === trade.exchangeOrderId),
            [srcAsset, dstAsset]: string[] = dbSubOrder.symbol.split('-'),
            isSellOrder = dbSubOrder.trades.length === 1,
            revert = dstAsset === 'DAI' ? true : false,
            executedAmount = trade.amount,
            traderAmount = executedAmount.multipliedBy(dbSubOrder.price),
            actualAmount = traderAmount.dividedBy(dbSubOrder.buyPrice),
            missedAmount = traderAmount.minus(dbSubOrder.trades.slice(1).reduce((total: BigNumber, current: Trade) => total.plus(current.amount), new BigNumber(0))),
            amount = !isSellOrder ? !revert ? actualAmount.lte(traderAmount) ? traderAmount : actualAmount.plus(traderAmount).dividedBy(2) : executedAmount : missedAmount,
            symbol = (revert ? ['USDT', dstAsset] : [dstAsset, 'USDT']).join('-'),
            symbolAlias = this.symbolAlias(symbol, dbSubOrder.exchange),
            side = revert ? 'sell' : 'buy',
            divPrice = dbSubOrder.buyPrice.multipliedBy(dbSubOrder.currentDev.plus(1)),
            price = revert ? new BigNumber(1).dividedBy(divPrice) : divPrice,
            type = isSellOrder ? 'limit' : 'market',
            filled = missedAmount.eq(0),
            buyTrade: Trade = new Trade()
        ;
        let sendOrder: SendOrder = null;
        if (isSellOrder || (dbSubOrder.trades.length === 2 && !filled)) {
            try {
                sendOrder = await this.connector.submitSubOrder(dbSubOrder.exchange, dbSubOrder.id, symbolAlias, side, amount, price, type);
            } catch (e) {
                log.error(e);
            }
        }
        if (sendOrder === null) {
            //TODO: send failed notification
        } else {
            buyTrade.exchange = dbSubOrder.exchange;
            buyTrade.exchangeOrderId = sendOrder.exchangeOrderId;
            buyTrade.order = dbSubOrder;
            buyTrade.symbol = symbol;
            buyTrade.symbolAlias = symbolAlias;
            buyTrade.price = price;
            buyTrade.amount = amount;
            buyTrade.side = side;
            buyTrade.timestamp = sendOrder.timestamp;
            buyTrade.type = 'limit';
            await this.db.insertTrade(buyTrade);
        }
        if (filled)
            dbSubOrder.status = Status.FILLED;
        else {
            log.log('Confirmation needed');
            //TODO: send notification to frontend
        }
        // upTrade.amount = trade.amount;
        // upTrade.price = trade.price;
        trade.status = 'ok';
        // await this.db.getRepository(Trade).save(trade);
        // await this.db.getRepository(SubOrder).save(dbSubOrder);

        const transaction = await this.db.getTransactionManager();

        await transaction.save(trade);
        await transaction.save(dbSubOrder);
    }

    // DEPOSIT/WITHDRAW

    /**
     * @param amount     1.23
     * @param assetName 'USDT'
     */
    async getExchangeForWithdraw(amount: BigNumber, assetName: string): Promise<{exchange: string, amountWithFee: BigNumber} | undefined> {
        for (const exchange in this.lastBalances) {
            if (this.lastBalances.hasOwnProperty(exchange)) {
                try {
                    const connector: Connector = this.connector.getConnector(exchange);
                    if (!connector.hasWithdraw()) continue;
                    const withdrawLimit: ExchangeWithdrawLimit = await connector.getWithdrawLimit(assetName);
                    if (!withdrawLimit || withdrawLimit.fee.isNaN() || withdrawLimit.min.isNaN()) continue;

                    let amountWithFee = amount.plus(withdrawLimit.fee);
                    if (amountWithFee.lt(withdrawLimit.min)) {
                        amountWithFee = withdrawLimit.min;
                    }

                    if (this.lastBalances[exchange][assetName].gt(amountWithFee)) {
                        return {exchange, amountWithFee};
                    }
                } catch (e) {
                    log.debug('Failed to get withdraw limit for ' + exchange, e);
                }
            }
        }
        return undefined;
    }

    /**
     * @param exchange  'binance'
     * @param amount     1.23
     * @param assetName 'ETH'
     */
    async exchangeWithdraw(exchange: string, amount: BigNumber, assetName: string): Promise<void> {
        if (!this.connector.hasWithdraw(exchange)) {
            log.log(exchange + ' does not support withdrawals');
            log.log('Please make a manual deposit ' + amount.toString() + ' ' + assetName + ' to the contract');
            return;
        }

        log.log('Withdrawing ' + amount.toString() + ' ' + assetName + ' from ' + exchange);
        const exchangeWithdrawId: string = await this.connector.withdraw(exchange, assetName, amount, this.orionBlockchain.address);
        if (exchangeWithdrawId) {
            await this.db.insertWithdraw(Object.assign(new Withdraw, {
                exchangeWithdrawId,
                exchange,
                currency: assetName,
                amount,
                status: 'pending'
            }));
        }
    }

    /**
     * @param amount     1.23
     * @param assetName 'USDT'
     */
    async approve(amount: BigNumber, assetName: string): Promise<void> {
        log.log('Approving ' + amount.toString() + ' ' + assetName);
        const transaction: Transaction = await this.orionBlockchain.approveERC20(amount, assetName);
        await this.db.insetTransaction(transaction);
    }

    /**
     * @param amount     1.23
     * @param assetName 'ETH'
     */
    async deposit(amount: BigNumber, assetName: string): Promise<void> {
        log.log('Depositing ' + amount.toString() + ' ' + assetName);

        const balance = await this.orionBlockchain.getWalletBalance();
        if (balance[assetName].lt(amount)) {
            log.log(`Only ${balance[assetName].toString()} ${assetName} on your wallet, not enough for a deposit`);
            return;
        }

        let transaction: Transaction;
        if (assetName === 'ETH') {
            transaction = await this.orionBlockchain.depositETH(amount);
        } else {
            const allowance: BigNumber = await this.orionBlockchain.getAllowance(assetName);
            if (allowance.gte(amount)) {
                transaction = await this.orionBlockchain.depositERC20(amount, assetName);
            } else {
                log.log(`Only ${allowance.toString()} ${assetName} approved, not enough for a deposit`);
                log.log(`Please use 'approve' command`);
            }
        }
        if (transaction) {
            await this.db.insetTransaction(transaction);
        }
    }

    /**
     * @param amount     1.23
     * @param assetName 'ETH'
     */
    async withdraw(amount: BigNumber, assetName: string): Promise<void> {
        log.log('Withdrawing ' + amount.toString() + ' ' + assetName);

        const balance = await this.orionBlockchain.getContractBalance();
        if (balance[assetName].lt(amount)) {
            log.log(`Only ${balance[assetName].toString()} ${assetName} on contract, not enough for a withdraw`);
            return;
        }

        const transaction: Transaction = await this.orionBlockchain.withdraw(amount, assetName);
        await this.db.insetTransaction(transaction);
    }

    /**
     * @param amount     1.23
     */
    async lockStake(amount: BigNumber): Promise<void> {
        log.log('Staking ' + amount.toString() + ' ORN');

        const balance = await this.orionBlockchain.getContractBalance();
        if (balance['ORN'].lt(amount)) {
            log.log(`Only ${balance['ORN'].toString()} ORN on contract, not enough for a stake`);
            log.log(`Please use 'deposit' command`);
            return;
        }

        const transaction: Transaction = await this.orionBlockchain.lockStake(amount);
        await this.db.insetTransaction(transaction);
    }

    async releaseStake(): Promise<void> {
        log.log('Realising ORN stake');
        const transaction: Transaction = await this.orionBlockchain.releaseStake();
        await this.db.insetTransaction(transaction);
    }
}
