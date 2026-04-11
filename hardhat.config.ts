import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-viem';

const config: HardhatUserConfig = {
  solidity: '0.8.20',
  networks: {
    base: {
      url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      accounts: process.env.MERKLE_PUBLISHER_KEY ? [process.env.MERKLE_PUBLISHER_KEY] : [],
    },
  },
};

export default config;
