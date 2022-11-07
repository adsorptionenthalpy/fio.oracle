import fs from "fs";
import Web3 from 'web3';
import config from "../config/config";
import {LOG_FILES_PATH_NAMES, LOG_DIRECTORY_PATH_NAME} from "./constants";
import fetch from "node-fetch";
import fioABI from "../config/ABI/FIO.json";
import fioNftABI from "../config/ABI/FIONFT.json";
import fioMaticNftABI from "../config/ABI/FIOMATICNFT.json";

export const replaceNewLines = (stringValue, replaceChar = ', ') => {
    return  stringValue.replace(/(?:\r\n|\r|\n)/g, replaceChar);
}

// function to handle all unexpected request errors (like bad internet connection or invalid response) and add them into Error.log file
export const handleServerError = async (err, additionalMessage = null) => {
    if (additionalMessage) console.log(additionalMessage+ ': ')
    console.log(err.stack)

    prepareLogDirectory(LOG_DIRECTORY_PATH_NAME, false);
    await prepareLogFile({ filePath: LOG_FILES_PATH_NAMES.oracleErrors }, false);

    addLogMessage({
        filePath: LOG_FILES_PATH_NAMES.oracleErrors,
        message: replaceNewLines((additionalMessage ?  (additionalMessage + ': ') : '') + err.stack),
    });
}

// function to handle all unexpected chains transactions errors and add them into Error.log file
export const handleChainError = ({logMessage, consoleMessage}) => {
    console.log(consoleMessage);
    addLogMessage({
        filePath: LOG_FILES_PATH_NAMES.oracleErrors,
        message: replaceNewLines(logMessage),
    });
}

export const prepareLogDirectory = (directoryPath, withLogsInConsole = true) => {
    if (fs.existsSync(directoryPath)) { //check if the log path exists
        if (withLogsInConsole) console.log("The log directory exists.");
    } else {
        if (withLogsInConsole) console.log('The log directory does not exist.');
        fs.mkdir(directoryPath, (err) => { //create new file
            if(err) {
                return console.log(err);
            }
            if (withLogsInConsole) console.log("The log directory was created!");
        });
    }
}

export const prepareLogFile = async ({
    filePath,
    fetchLastBlockNumber = null,
}, withLogsInConsole = true) => {
    if (fs.existsSync(filePath)) { //check file exist
        if (withLogsInConsole) console.log(`The file ${filePath} exists.`);
        if (fetchLastBlockNumber) {
            const lastProcessedBlockNumber = fs.readFileSync(filePath, 'utf8');

            if (!lastProcessedBlockNumber) {
                let lastBlockNumberInChain;
                if (fetchLastBlockNumber) lastBlockNumberInChain = await fetchLastBlockNumber();
                fs.writeFileSync(filePath, lastBlockNumberInChain ? lastBlockNumberInChain.toString() : '', (err) => { //create new file
                    if (err) {
                        return console.log(err);
                    }
                    if (withLogsInConsole) console.log(`The file ${filePath} was saved!`);
                });
            }
        }
    } else {
        if (withLogsInConsole) console.log(`The file ${filePath} does not exist.`);
        let lastBlockNumberInChain;
        if (fetchLastBlockNumber) lastBlockNumberInChain = await fetchLastBlockNumber();
        fs.writeFileSync(filePath, lastBlockNumberInChain ? lastBlockNumberInChain.toString() : '', (err) => { //create new file
            if (err) {
                return console.log(err);
            }
            if (withLogsInConsole) console.log(`The file ${filePath} was saved!`);
        });
    }
}

export const addLogMessage = ({
    filePath,
    timestampTitle = '',
    addTimestamp = true,
    message,
}) => {
    const isJsonFormat = typeof message === 'object';
    const timeStamp = new Date().toISOString();

    if (isJsonFormat) {
        if (addTimestamp) message[(timestampTitle && timestampTitle.length) ? timestampTitle : 'timeStamp'] = timeStamp
        fs.appendFileSync(filePath, JSON.stringify(message) +'\r\n')
    } else {
        fs.appendFileSync(filePath, (addTimestamp ? (timestampTitle + timeStamp + ' ') : '') + message +'\r\n');
    }
}

export const convertWeiToGwei = (weiValue) => {
    return parseFloat(Web3.utils.fromWei(typeof weiValue === 'number' ? weiValue + '': weiValue, 'gwei'))
}

export const convertGweiToWei = (gweiValue) => {
    return parseFloat(Web3.utils.toWei(gweiValue, 'gwei'));
}

export const convertWeiToEth = (weiValue) => {
    return parseFloat(Web3.utils.fromWei(typeof weiValue === 'number' ? weiValue + '': weiValue, "ether"));
}

export const updateBlockNumberFIO = (blockNumber) => {
    fs.writeFileSync(LOG_FILES_PATH_NAMES.blockNumberFIO, blockNumber);
}
export const updateBlockNumberForTokensUnwrappingOnETH = (blockNumber) => {
    fs.writeFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapTokensETH, blockNumber);
}
export const updateBlockNumberForDomainsUnwrappingOnETH = (blockNumber) => {
    fs.writeFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapDomainETH, blockNumber);
}
export const updateBlockNumberMATIC = (blockNumber) => {
    fs.writeFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapDomainPolygon, blockNumber);
}

export const getLastProceededBlockNumberOnFioChain = () => {
    return parseFloat(fs.readFileSync(LOG_FILES_PATH_NAMES.blockNumberFIO, 'utf8'));
}
export const getLastProceededBlockNumberOnEthereumChainForTokensUnwrapping = () => {
    return parseFloat(fs.readFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapTokensETH, 'utf8'));
}
export const getLastProceededBlockNumberOnEthereumChainForDomainUnwrapping = () => {
    return parseFloat(fs.readFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapDomainETH, 'utf8'));
}
export const getLastProceededBlockNumberOnPolygonChainForDomainUnwrapping = () => {
    return parseFloat(fs.readFileSync(LOG_FILES_PATH_NAMES.blockNumberUnwrapDomainPolygon, 'utf8'));
}

export const convertNativeFioIntoFio = (nativeFioValue) => {
    const fioDecimals = 1000000000;
    return parseInt(nativeFioValue + '') / fioDecimals;
}

export const checkHttpResponseStatus = async (response, additionalErrorMessage = null) => {
    if (response.ok) {
        // response.status >= 200 && response.status < 300
        return response;
    } else {
        if (additionalErrorMessage) console.log(additionalErrorMessage)
        const errorBody = await response.text();
        throw new Error(errorBody);
    }
}

export const handleUpdatePendingWrapItemsQueue = ({
    action,
    logFilePath,
    logPrefix,
    jobIsRunningCacheKey,
}) => {
    let csvContent = fs.readFileSync(logFilePath).toString().split('\r\n'); // read file and convert to array by line break
    csvContent.shift(); // remove the first element from array

    if (csvContent.length > 0 && csvContent[0] !== '') {
        const newLogFileDataToSave = csvContent.join('\r\n'); // convert array back to string
        fs.writeFileSync(logFilePath, newLogFileDataToSave);
        console.log(logPrefix + `${logFilePath} log file was successfully updated.`);
        action();
    } else {
        console.log(logPrefix + `${logFilePath} log file was successfully updated.`);
        fs.writeFileSync(logFilePath, "");
        config.oracleCache.set(jobIsRunningCacheKey, false, 0);
    }
}

export const handleLogFailedWrapItem = ({
    logPrefix,
    txId,
    wrapData,
    errorLogFilePath,
}) => {
    console.log(logPrefix + `something went wrong, storing transaction data into ${errorLogFilePath}`)
    const wrapText = txId + ' ' + JSON.stringify(wrapData) + '\r\n';
    fs.appendFileSync(errorLogFilePath, wrapText) // store issued transaction to errored log file queue by line-break
}

// base gas price value + 10%
export const calculateAverageGasPrice = (val) => {
    return Math.ceil(val + val * 0.1);
}
// base gas price value + 20%
export const calculateHighGasPrice = (val) => {
    return Math.ceil(val + val * 0.2);
}

// ETH gas price suggestion in WEI
export const getEthGasPriceSuggestion = async () => {
    const gasPriceSuggestion = await (await fetch(process.env.ETHINFURA, {
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_gasPrice",
            params: [],
            id:1
        }),
        method: 'POST',
    })).json();

    let value = null;

    if (gasPriceSuggestion && gasPriceSuggestion.result) {
        value = parseInt(gasPriceSuggestion.result);
    }

    return value;
}

// POLYGON gas price suggestion in WEI
export const getPolygonGasPriceSuggestion = async () => {
    const gasPriceSuggestion = await (await fetch(process.env.POLYGON_INFURA, {
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_gasPrice",
            params: [],
            id:1
        }),
        method: 'POST',
    })).json();

    let value = null;

    if (gasPriceSuggestion && gasPriceSuggestion.result) {
        value = parseInt(gasPriceSuggestion.result);
    }

    return value;
}

export const isOracleEthAddressValid = async (isTokens = true) => {
    const web3 = new Web3(process.env.ETHINFURA);
    const contract = new web3.eth.Contract(isTokens ? fioABI : fioNftABI, isTokens ? process.env.FIO_TOKEN_ETH_CONTRACT : process.env.FIO_NFT_ETH_CONTRACT);

    const registeredOraclesPublicKeys = await contract.methods.getOracles().call();

    return !!(registeredOraclesPublicKeys.map(registeredOracle => registeredOracle.toLowerCase()).includes(process.env.ETH_ORACLE_PUBLIC.toLowerCase()))
}

export const isOraclePolygonAddressValid = async () => {
    const web3 = new Web3(process.env.POLYGON_INFURA);
    const contract = new web3.eth.Contract(fioMaticNftABI, process.env.FIO_NFT_POLYGON_CONTRACT);

    const registeredOraclesPublicKeys = await contract.methods.getOracles().call();

    return !!(registeredOraclesPublicKeys.map(registeredOracle => registeredOracle.toLowerCase()).includes(process.env.POLYGON_ORACLE_PUBLIC.toLowerCase()))
}

const checkEthBlockNumbers = async () => {
    const web3 = new Web3(process.env.ETHINFURA);
    const promise1 = new Promise(async (resolve) => {
        resolve(await web3.eth.getBlockNumber());
    })
    const promise2 = new Promise(async (resolve) => {
        resolve((await web3.eth.getBlock('latest')).number);
    })
    const promise3 = new Promise(async (resolve) => {
        resolve((await web3.eth.getBlock('pending')).number);
    })

    const res = await Promise.all([promise1, promise2, promise3])
    console.log(JSON.stringify(res))
}
