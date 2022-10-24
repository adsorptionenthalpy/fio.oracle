import config from "../../config/config";

require('dotenv').config();
import Web3 from "web3";
import fioABI from '../../config/ABI/FIO.json';
import fioNftABI from "../../config/ABI/FIONFT.json";
import {
    addLogMessage,
    convertGweiToWei,
    convertNativeFioIntoFio,
    convertWeiToEth,
    convertWeiToGwei,
    handleChainError,
    handleServerError
} from "../helpers";
import {LOG_FILES_PATH_NAMES, ORACLE_CACHE_KEYS} from "../constants";

// todo: 'ethereumjs-tx' has been deprecated, update to @ethereumjs/tx
const Tx = require('ethereumjs-tx').Transaction;

const fetch = require('node-fetch');
const fs = require('fs');

const { TextEncoder, TextDecoder } = require('text-encoding');

class EthCtrl {
    constructor() {
        this.web3 = new Web3(process.env.ETHINFURA);
        this.fioContract = new this.web3.eth.Contract(fioABI, process.env.FIO_TOKEN_ETH_CONTRACT);
        this.fioNftContract = new this.web3.eth.Contract(fioNftABI, process.env.FIO_NFT_ETH_CONTRACT);
    }

    async wrapFioToken(txIdOnFioChain, wrapData) {
        const logPrefix = `ETH, wrapFioToken, FIO tx_id: "${txIdOnFioChain}", amount: ${convertNativeFioIntoFio(wrapData.amount)} FIO --> `
        console.log(logPrefix + 'Executing wrapFioToken, data to wrap:');
        console.log(wrapData)

        if (!config.oracleCache.get(ORACLE_CACHE_KEYS.isWrapTokensExecuting))
            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, true, 0); // ttl = 0 means that value shouldn't ever been expired

        try {
            const quantity = wrapData.amount;
            const gasPriceSuggestions = await (await fetch(process.env.ETH_API_URL)).json();

            const isUsingGasApi = !!parseInt(process.env.USEGASAPI);
            let gasPrice = 0;
            if ((isUsingGasApi && gasPriceSuggestions.status === "1") || (!isUsingGasApi && parseInt(process.env.TGASPRICE) <= 0)) {
                console.log(logPrefix + 'using gasPrice value from the api:');
                if (process.env.GASPRICELEVEL === "average") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.ProposeGasPrice);
                } else if(process.env.GASPRICELEVEL === "low") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.SafeGasPrice);
                } else if(process.env.GASPRICELEVEL === "high") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.FastGasPrice);
                }
            } else if (!isUsingGasApi || (isUsingGasApi && gasPriceSuggestions.status === "0")){
                console.log(logPrefix + 'using gasPrice value from the .env:');
                gasPrice = convertGweiToWei(process.env.TGASPRICE);
            }

            if (!gasPrice) throw new Error(logPrefix + 'Cannot set valid Gas Price value');

            const gasLimit = parseFloat(process.env.TGASLIMIT);

            console.log('gasPrice = ' + gasPrice + ` (${convertWeiToGwei(gasPrice)} GWEI)`)
            console.log('gasLimit = ' + gasLimit)

            // we shouldn't await it to do not block the rest of the actions flow
            this.web3.eth.getBalance(process.env.ETH_ORACLE_PUBLIC, 'latest', (error, oracleBalance) => {
                if (error) {
                    console.log(logPrefix + error.stack)
                } else {
                    if (convertWeiToEth(oracleBalance) < ((convertWeiToEth(gasLimit * gasPrice)) * 5)) {
                        const timeStamp = new Date().toISOString();
                        console.log(logPrefix + `Warning: Low Oracle ETH Address Balance: ${convertWeiToEth(oracleBalance)} ETH`)
                        fs.writeFileSync(LOG_FILES_PATH_NAMES.oracleErrors, timeStamp + ' ' + logPrefix + `Warning: Low Oracle ETH Address Balance: ${convertWeiToEth(oracleBalance)} ETH`)
                    }
                }
            })

            const registeredOraclesPublicKeys = await this.fioContract.methods.getOracles().call();
            if (registeredOraclesPublicKeys.includes(process.env.ETH_ORACLE_PUBLIC)) {
                let isTransactionProceededSuccessfully = false;
                try {
                    const oraclePublicKey = process.env.ETH_ORACLE_PUBLIC;
                    const oraclePrivateKey = process.env.ETH_ORACLE_PRIVATE;

                    // Commented this out. It was throwing an uncaught exception so I added the .catch, but still throws an error.
                    // We have changed how to check consensus.
                    // todo: check if we should make wrap call (maybe just jump to read logs file) in case of already approved transaction by current oracle (do not forget to await)
                    // this.fioContract.methods.getApproval(txIdOnFioChain).call()
                    //     .then((response) => {
                    //         console.log(logPrefix + 'Oracles Approvals:');
                    //         console.log(response);
                    //     }).catch(err => {
                    //         console.log ('Error: ', err);
                    //     });

                    if (this.web3.utils.isAddress(wrapData.public_address) === true && wrapData.chain_code === "ETH") { //check validation if the address is ERC20 address
                        console.log(logPrefix + `requesting wrap action of ${convertNativeFioIntoFio(quantity)} FIO tokens to "${wrapData.public_address}"`)
                        const wrapTokensFunction = this.fioContract.methods.wrap(wrapData.public_address, quantity, txIdOnFioChain);
                        let wrapABI = wrapTokensFunction.encodeABI();
                        const nonce = await this.web3.eth.getTransactionCount(oraclePublicKey); //calculate nonce value for transaction
                        console.log(logPrefix + 'nonce number: ' + nonce)

                        const ethTransaction = new Tx(
                            {
                                gasPrice: this.web3.utils.toHex(gasPrice),
                                gasLimit: this.web3.utils.toHex(gasLimit),
                                to: process.env.FIO_TOKEN_ETH_CONTRACT,
                                data: wrapABI,
                                from: oraclePublicKey,
                                nonce: this.web3.utils.toHex(nonce)
                            },
                            { chain: process.env.MODE === 'testnet' ? process.env.ETH_TESTNET_CHAIN_NAME : 'mainnet' }
                        );

                        addLogMessage({
                            filePath: LOG_FILES_PATH_NAMES.ETH,
                            message: 'ETH' + ' ' + 'fio.erc20' + ' ' + 'wraptokens submit' + ' {gasPrice: ' + gasPrice + ', gasLimit: ' + gasLimit + ', amount: ' + quantity + ', to: ' + process.env.FIO_TOKEN_ETH_CONTRACT + ', from: ' + oraclePublicKey + '}',
                        });

                        const privateKey = Buffer.from(oraclePrivateKey, 'hex');
                        ethTransaction.sign(privateKey);
                        const serializedTx = ethTransaction.serialize();
                        await this.web3.eth //excute the sign transaction using public key and private key of oracle
                            .sendSignedTransaction('0x' + serializedTx.toString('hex'))
                            .on('transactionHash', (hash) => {
                                console.log(logPrefix + 'transaction has been signed and sent into the chain.')
                                console.log('TxHash: ', hash);
                            })
                            .on('receipt', (receipt) => {
                                console.log(logPrefix + "completed");
                                addLogMessage({
                                    filePath: LOG_FILES_PATH_NAMES.ETH,
                                    message: 'ETH' + ' ' + 'fio.erc20' + ' ' + 'wraptokens receipt' + ' ' + JSON.stringify(receipt),
                                });
                                isTransactionProceededSuccessfully = true;
                            })
                            .on('error', (error, receipt) => {
                                console.log(logPrefix + 'transaction has been failed.') //error message will be logged by catch block

                                if (receipt && receipt.blockHash && !receipt.status) console.log(logPrefix + 'It looks like the transaction ended out of gas. Or Oracle has already approved this ObtId. Also, check nonce value')
                            });

                        if (!isTransactionProceededSuccessfully) {
                            console.log(logPrefix + `something went wrong, storing transaction data into ${LOG_FILES_PATH_NAMES.wrapTokensTransactionError}`)
                            const wrapText = txIdOnFioChain + ' ' + JSON.stringify(wrapData) + '\r\n';
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapTokensTransactionError, wrapText); // store issued transaction to log by line-break
                        }
                        let csvContent = fs.readFileSync(LOG_FILES_PATH_NAMES.wrapTokensTransaction).toString().split('\r\n'); // read file and convert to array by line break
                        csvContent.shift(); // remove the first element from array
                        let nextFioWrapTokensTransactionIdToProceed;
                        let nextFioWrapTokensTransactionData;
                        if (csvContent.length > 0 && csvContent[0] !== '') { //check if the queue is empty
                            nextFioWrapTokensTransactionIdToProceed = csvContent[0].split(' ')[0];
                            nextFioWrapTokensTransactionData = JSON.parse(csvContent[0].split(' ')[1]);
                            console.log(logPrefix + `preparing to execute next wrap transaction from ${LOG_FILES_PATH_NAMES.wrapTokensTransaction} log file for FIO tx_id: ${nextFioWrapTokensTransactionIdToProceed}`);
                            this.wrapFioToken(nextFioWrapTokensTransactionIdToProceed, nextFioWrapTokensTransactionData); //execute next transaction from transaction log
                            csvContent = csvContent.join('\r\n'); // convert array back to string
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapTokensTransaction, csvContent)
                            console.log(logPrefix + `${LOG_FILES_PATH_NAMES.wrapTokensTransaction} log file was successfully updated.`)
                        } else {
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapTokensTransaction, "")
                            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, false, 0);
                            console.log(logPrefix + `requesting wrap action of ${convertNativeFioIntoFio(quantity)} FIO tokens to ${wrapData.public_address}: successfully completed`)
                            return 0;
                        }
                        console.log(logPrefix + `requesting wrap action of ${convertNativeFioIntoFio(quantity)} FIO tokens to ${wrapData.public_address}: successfully completed`)
                    } else {
                        config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, false, 0);
                        console.log(logPrefix + "Invalid Address");
                    }
                } catch (error) {
                    config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, false, 0);

                    handleChainError({
                        logMessage: 'ETH' + ' ' + 'fio.erc20' + ' ' + 'wraptokens' + ' ' + error,
                        consoleMessage: logPrefix + error.stack
                    });
                }
            } else {
                config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, false, 0);
            }
        } catch (err) {
            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapTokensExecuting, false, 0);
            handleServerError(err, 'ETH, wrapFioToken');
        }
    }

    async wrapFioDomain(txIdOnFioChain, wrapData) {
        const logPrefix = `ETH, wrapFioDomain, FIO tx_id: "${txIdOnFioChain}", domain: "${wrapData.fio_domain}" --> `
        console.log(logPrefix + 'Executing wrapFioDomain, data to wrap:');
        console.log(wrapData)

        if (!config.oracleCache.get(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting))
            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, true, 0);

        try {
            const gasPriceSuggestions = await (await fetch(process.env.ETH_API_URL)).json();

            const isUsingGasApi = !!parseInt(process.env.USEGASAPI);
            let gasPrice = 0;
            if ((isUsingGasApi && gasPriceSuggestions.status === "1") || (!isUsingGasApi && parseInt(process.env.TGASPRICE) <= 0)) {
                console.log(logPrefix + 'using gasPrice value from the api:');
                if (process.env.GASPRICELEVEL === "average") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.ProposeGasPrice);
                } else if(process.env.GASPRICELEVEL === "low") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.SafeGasPrice);
                } else if(process.env.GASPRICELEVEL === "high") {
                    gasPrice = convertGweiToWei(gasPriceSuggestions.result.FastGasPrice);
                }
            } else if (!isUsingGasApi || (isUsingGasApi && gasPriceSuggestions.status === "0")){
                console.log(logPrefix + 'using gasPrice value from the .env:');
                gasPrice = convertGweiToWei(process.env.TGASPRICE);
            }

            if (!gasPrice) throw new Error(logPrefix + 'Cannot set valid Gas Price value');

            const gasLimit = parseFloat(process.env.TGASLIMIT);

            console.log('gasPrice = ' + gasPrice + ` (${convertWeiToGwei(gasPrice)} GWEI)`)
            console.log('gasLimit = ' + gasLimit)

            // we shouldn't await it to do not block the rest of the actions flow
            this.web3.eth.getBalance(process.env.ETH_ORACLE_PUBLIC, 'latest', (error, oracleBalance) => {
                if (error) {
                    console.log(logPrefix + error.stack)
                } else {
                    if (convertWeiToEth(oracleBalance) < ((convertWeiToEth(gasLimit * gasPrice)) * 5)) {
                        const timeStamp = new Date().toISOString();
                        console.log(logPrefix + `Warning: Low Oracle ETH Address Balance: ${convertWeiToEth(oracleBalance)} ETH`)
                        fs.writeFileSync(LOG_FILES_PATH_NAMES.oracleErrors, timeStamp + ' ' + logPrefix + `Warning: Low Oracle ETH Address Balance: ${convertWeiToEth(oracleBalance)} ETH`)
                    }
                }
            })

            const registeredOraclesPublicKeys = await this.fioContract.methods.getOracles().call();
            if (registeredOraclesPublicKeys.includes(process.env.ETH_ORACLE_PUBLIC)) {
                let isTransactionProceededSuccessfully = false;
                try {
                    const oraclePublicKey = process.env.ETH_ORACLE_PUBLIC;
                    const oraclePrivateKey = process.env.ETH_ORACLE_PRIVATE;

                    if (this.web3.utils.isAddress(wrapData.public_address) === true && wrapData.chain_code === "ETH") { //check validation if the address is ERC721 address
                        console.log(logPrefix + `requesting wrap action of domain: "${wrapData.fio_domain}", to "${wrapData.public_address}"`)
                        const wrapDomainFunction = this.fioNftContract.methods.wrapnft(wrapData.public_address, wrapData.fio_domain, txIdOnFioChain);
                        let wrapABI = wrapDomainFunction.encodeABI();
                        const nonce = await this.web3.eth.getTransactionCount(oraclePublicKey); //calculate nonce value for transaction
                        console.log(logPrefix + 'nonce number: ' + nonce)

                        const ethTransaction = new Tx(
                            {
                                gasPrice: this.web3.utils.toHex(gasPrice),
                                gasLimit: this.web3.utils.toHex(gasLimit),
                                to: process.env.FIO_NFT_ETH_CONTRACT,
                                data: wrapABI,
                                from: oraclePublicKey,
                                nonce: this.web3.utils.toHex(nonce)
                            },
                            { chain: process.env.MODE === 'testnet' ? process.env.ETH_TESTNET_CHAIN_NAME : 'mainnet' }
                        );

                        addLogMessage({
                            filePath: LOG_FILES_PATH_NAMES.ETH,
                            message: 'ETH' + ' ' + 'fio.erc721' + ' ' + 'wrapdomain submit' + ' {gasPrice: ' + gasPrice + ', gasLimit: ' + gasLimit + ', domain: ' + wrapData.fio_domain + ', to: ' + process.env.FIO_NFT_ETH_CONTRACT + ', from: ' + oraclePublicKey + '}',
                        });

                        const privateKey = Buffer.from(oraclePrivateKey, 'hex');
                        ethTransaction.sign(privateKey);
                        const serializedTx = ethTransaction.serialize();

                        await this.web3.eth //excute the sign transaction using public key and private key of oracle
                            .sendSignedTransaction('0x' + serializedTx.toString('hex'))
                            .on('transactionHash', (hash) => {
                                console.log(logPrefix + 'transaction has been signed and sent into the chain.')
                                console.log('TxHash: ', hash);
                            })
                            .on('receipt', (receipt) => {
                                console.log(logPrefix + "completed");
                                addLogMessage({
                                    filePath: LOG_FILES_PATH_NAMES.ETH,
                                    message: 'ETH' + ' ' + 'fio.erc721' + ' ' + 'wrapdomain' + ' ' + JSON.stringify(receipt),
                                });
                                isTransactionProceededSuccessfully = true;
                            })
                            .on('error', (error, receipt) => {
                                console.log(logPrefix + 'transaction has been failed.') //error message will be logged by catch block

                                if (receipt && receipt.blockHash && !receipt.status) console.log(logPrefix + 'It looks like the transaction ended out of gas. Or Oracle has already approved this ObtId. Also, check nonce value')
                            });

                        if (!isTransactionProceededSuccessfully) {
                            console.log(logPrefix + `something went wrong, storing transaction data into ${LOG_FILES_PATH_NAMES.wrapDomainByEthTransactionError}`)
                            const wrapText = txIdOnFioChain + ' ' + JSON.stringify(wrapData) + '\r\n';
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapDomainByEthTransactionError, wrapText); // store issued transaction to log by line-break
                        }
                        let csvContent = fs.readFileSync(LOG_FILES_PATH_NAMES.wrapDomainByEthTransaction).toString().split('\r\n'); // read file and convert to array by line break
                        csvContent.shift(); // remove the first element from array
                        let nextFioWrapDomainTransactionIdToProceed;
                        let nextFioWrapDomainTransactionData;
                        if (csvContent.length > 0 && csvContent[0] !== '') { //check if the queue is empty
                            nextFioWrapDomainTransactionIdToProceed = csvContent[0].split(' ')[0];
                            nextFioWrapDomainTransactionData = JSON.parse(csvContent[0].split(' ')[1]);
                            console.log(logPrefix + `preparing to execute next wrap domain transaction from ${LOG_FILES_PATH_NAMES.wrapDomainByEthTransaction} log file for FIO tx_id: ${nextFioWrapDomainTransactionIdToProceed}`);
                            this.wrapFioDomain(nextFioWrapDomainTransactionIdToProceed, nextFioWrapDomainTransactionData); //execute next transaction from transaction log
                            csvContent = csvContent.join('\r\n'); // convert array back to string
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapDomainByEthTransaction, csvContent)
                            console.log(logPrefix + `${LOG_FILES_PATH_NAMES.wrapDomainByEthTransaction} log file was successfully updated.`)
                        } else {
                            fs.writeFileSync(LOG_FILES_PATH_NAMES.wrapDomainByEthTransaction, "")
                            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, false, 0);
                            console.log(logPrefix + `Successfully completed.`)
                            return 0;
                        }
                        console.log(logPrefix + `Successfully completed.`)
                    } else {
                        config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, false, 0);
                        console.log(logPrefix + "Invalid Address");
                    }
                } catch (error) {
                    config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, false, 0);

                    handleChainError({
                        logMessage: 'ETH' +' ' + 'fio.erc721' + ' ' + 'wrapdomain' + ' ' + error,
                        consoleMessage: logPrefix + error.stack
                    });
                }
            } else {
                config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, false, 0);
            }
        } catch (err) {
            config.oracleCache.set(ORACLE_CACHE_KEYS.isWrapDomainByETHExecuting, false, 0);
            handleServerError(err, 'ETH, wrapFioDomain');
        }
    }

}

export default new EthCtrl();
