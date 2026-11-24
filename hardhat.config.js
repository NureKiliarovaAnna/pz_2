require("dotenv").config();

require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("hardhat-gas-reporter");

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL;
const sepoliaPrivateKey = process.env.SEPOLIA_PRIVATE_KEY;

const networks = {
  hardhat: {
    chainId: 31337,
  },

  localhost: {
    url: "http://127.0.0.1:8545",
    chainId: 31337,
  },
};

if (sepoliaRpcUrl) {
  networks.sepolia = {
    url: sepoliaRpcUrl,
    chainId: 11155111,
    accounts: sepoliaPrivateKey ? [sepoliaPrivateKey] : [],
  };
}

module.exports = {
  solidity: {
    version: "0.8.28",

    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },

      evmVersion: "cancun",
    },
  },

  networks,

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    noColors: true,
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    excludeContracts: [
      "PayoutAttacker",
      "VulnerableDAOTreasury",
      "TreasuryCaller",
      "RejectingRecipient",
    ],
  },

  mocha: {
    timeout: 60000,
  },
};