require('@nomicfoundation/hardhat-toolbox');
const networkConfig = require('./network.config.js');

const assert = (condition, message) => {
  if (condition) return;
  throw new Error(message);
}

task('deploy-factory', 'Deploys LootboxFactory')
.setAction(async () => {
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer] = await ethers.getSigners();

  const { linkToken, vrfV2Wrapper } = networkConfig[chainId];

  const lootboxFactoryFactory = await ethers.getContractFactory('LootboxFactory');
  const lootboxFactory = await lootboxFactoryFactory.deploy(linkToken, vrfV2Wrapper);
  await lootboxFactory.deployed();
  console.log('LootboxFactory deployed to:', lootboxFactory.address, network.name);

  // TODO: Add etherscan verification step.
});

// All following tasks are for testing and development purpuses only.

task('deploy-lootbox', 'Deploys an ERC1155 Lootbox through a factory')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('uri', 'Lootbox metadata URI', '') // TODO: Add a default metadata URI.
.addOptionalParam('id', 'Lootbox id for contract address predictability', '0')
.addOptionalParam('linkamount', 'Amount of LINK to transfer to lootbox', '100')
.setAction(async ({ factory, uri, id, linkamount }) => {
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer] = await ethers.getSigners();

  const { linkToken, linkHolder } = networkConfig[chainId];
  const link = await ethers.getContractAt('IERC20', linkToken);
  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  const impersonatedLinkHolder = await ethers.getImpersonatedSigner(linkHolder);
  await(await link.connect(impersonatedLinkHolder)
    .transfer(deployer.address, ethers.utils.parseUnits('1000000'))).wait();

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  await (await lootboxFactory.deployLootbox(uri, id)).wait();
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);

  console.log('Lootbox deployed to:', lootboxAddress, network.name);
  await(await link.connect(deployer)
    .transfer(lootboxAddress, ethers.utils.parseUnits(linkamount))).wait();
  console.log(`Transferred ${linkamount} LINK to the lootbox contract.`);
});

module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 1000 },
    },
  },
  defaultNetwork: 'localhost',
  networks: {
    localhost: {
      chainId: 31337,
      url: 'http://127.0.0.1:8545/',
    },
    hardhat: {
      allowUnlimitedContractSize: true,
      forking: {
        url: 'https://cloudflare-eth.com',
      },
      accounts: [
        {
          privateKey: '57b26bc4bcfd781dcab2fbda189bbf9eb124c7084690571ce185294cbb3d010a',
          balance: '10000000000000000000000',
        },
        {
          privateKey: '7bb779a88af05bc9bc0d0a1da4357cced604f545459a532f92c3eb6d42f1900c',
          balance: '10000000000000000000000',
        },
        {
          privateKey: '8c2fa29c9d3b9dfd7e1230296e1038f8e27d16ce4a5bbbbcb629ac8f0f00e9c9',
          balance: '10000000000000000000000',
        },
      ],
    },
    mainnet: {
      url: process.env.MAINNET_URL || 'https://cloudflare-eth.com',
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      chainId: 11155111,
      url: process.env.SEPOLIA_URL || '',
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    goerli: {
      chainId: 5,
      url: process.env.GOERLI_URL || '',
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: 'USD',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};
