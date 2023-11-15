const { setBalance } = require('@nomicfoundation/hardhat-network-helpers');
require('@nomicfoundation/hardhat-toolbox');
require('hardhat-docgen');
require('@chainsafe/hardhat-ts-artifact-plugin');
require('dotenv').config();
const { LedgerSigner } = require('@anders-t/ethers-ledger');
const networkConfig = require('./network.config.js');
const util = require('node:util');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const sleep = (msec) => {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), msec);
  });
}

const isSet = (param) => {
  return param && param.length > 0;
}

const assert = (condition, message) => {
  if (condition) return;
  throw new Error(message);
}

async function deploy(contractName, signer, ...params) {
  const factory = await ethers.getContractFactory(contractName);
  const instance = await factory.connect(signer).deploy(...params);
  await instance.deployed();
  console.log(`${contractName} deployed to: ${instance.address}`);
  return instance;
}

async function getContract(contractName, deployer, nonce) {
  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce,
  });
  return await ethers.getContractAt(contractName, predictedAddress);
}

task('deploy-factory', 'Deploys LootboxFactory')
.addOptionalParam('verify', 'Verify the deployed factory', 'false', types.bool)
.setAction(async ({ verify }) => {
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  let [deployer] = await ethers.getSigners();
  if (process.env.LEDGER_ADDRESS) {
    console.log(`Using ledger ${process.env.LEDGER_PATH || 'default'} derivation path.`);
    console.log(`Using ledger ${process.env.LEDGER_ADDRESS} address.`);
    deployer = new LedgerSigner(ethers.provider, process.env.LEDGER_PATH);
    deployer.address = process.env.LEDGER_ADDRESS;
  }
  const { linkToken, vrfV2Wrapper, name } = networkConfig[chainId];

  const gasMultiplier = name.includes('arbi') ? 10 : 1;

  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const lootboxAddress = ethers.utils.getContractAddress({from: deployer.address, nonce: nonce + 1});
  const viewAddress = ethers.utils.getContractAddress({from: deployer.address, nonce: nonce + 2});
  const factory = await deploy('LootboxFactory', deployer, linkToken, lootboxAddress, {nonce, gasLimit: 1500000 * gasMultiplier});
  await deploy('Lootbox', deployer, linkToken, vrfV2Wrapper, viewAddress, factory.address, {nonce: nonce + 1, gasLimit: 6000000 * gasMultiplier});
  await deploy('LootboxView', deployer, linkToken, vrfV2Wrapper, factory.address, {nonce: nonce + 2, gasLimit: 3500000 * gasMultiplier});

  if (verify === 'true') {
    console.log('Waiting half a minute to start verification');
    await sleep(30000);
    await hre.run('verify:verify', {
      address: factory.address,
      constructorArguments: [linkToken, lootboxAddress],
    });
    await hre.run('verify:verify', {
      address: lootboxAddress,
      constructorArguments: [linkToken, vrfV2Wrapper, viewAddress, factory.address],
    });
    await hre.run('verify:verify', {
      address: viewAddress,
      constructorArguments: [linkToken, vrfV2Wrapper, factory.address],
    });
  }
});

task('transfer-ownership', 'Transfer LootboxFactory ownership')
.addParam('factory', 'LootboxFactory address')
.addParam('to', 'Address of the new owner')
.setAction(async ({ factory, to }) => {
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  let [deployer] = await ethers.getSigners();

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const tx = await lootboxFactory.transferOwnership(to);

  console.log(`Ownership transfer: ${tx.hash}`);
});

// All the following tasks are for testing and development purpuses only.

task('deploy-lootbox', 'Deploys an ERC1155 Lootbox through a factory along with the reward tokens')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('uri', 'Lootbox metadata URI', 'https://bafybeicxxp4o5vxpesym2cvg4cqmxnwhwgpqawhhvxttrz2dlpxjyiob64.ipfs.nftstorage.link/{id}')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('linkamount', 'Amount of LINK to transfer to lootbox', 100, types.int)
.setAction(async ({ factory, uri, id, linkamount }) => {
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier] = await ethers.getSigners();

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

  console.log('Lootbox deployed to:', lootboxAddress);
  await(await link.connect(deployer)
    .transfer(lootboxAddress, ethers.utils.parseUnits(linkamount.toString()))).wait();
  console.log(`Transferred ${linkamount} LINK to the lootbox contract.`);

  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);
  await (await lootbox.addSuppliers([supplier.address])).wait();
  console.log(`Supplier ${supplier.address} added to the lootbox contract.`);

  const erc20 = await deploy('MockERC20', supplier, 100000n * 10n**18n);
  const erc721 = await deploy('MockERC721', supplier, 20);
  const erc1155 = await deploy('MockERC1155', supplier, 10, 1000);
  const erc1155NFT = await deploy('MockERC1155NFT', supplier, 15);

  await (await lootbox.connect(deployer).addTokens([
    erc20.address,
    erc721.address,
    erc1155.address,
    erc1155NFT.address,
  ])).wait();
  console.log('Allowed tokens to be used as rewards in the lootbox contract.');
});

task('supply-rewards', 'Transfer rewards to the previously deployed lootbox contract')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('type', 'Reward token type, ERC20, ERC721, ERC1155 or ERC1155NFT', 'ERC721')
.addOptionalParam('tokenid', 'Reward token id, not needed for ERC20', 0, types.int)
.addOptionalParam('amount', 'Reward token amount, not needed for ERC721 and ERC1155NFT', '1')
.setAction(async ({ factory, id, type, tokenid, amount }) => {
  amount = BigInt(amount);
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier] = await ethers.getSigners();

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  const erc20 = await getContract('MockERC20', supplier, 0);
  const erc721 = await getContract('MockERC721', supplier, 1);
  const erc1155 = await getContract('MockERC1155', supplier, 2);
  const erc1155NFT = await getContract('MockERC1155NFT', supplier, 3);

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);

  if (type == 'ERC20') {
    await (await erc20.connect(supplier).transfer(lootboxAddress, amount)).wait();
  } else if (type == 'ERC721') {
    await (await erc721.connect(supplier)['safeTransferFrom(address,address,uint256)'](supplier.address, lootboxAddress, tokenid)).wait();
  } else if (type == 'ERC1155') {
    assert(amount > 1, 'ERC1155 should be transferred in amount > 1 to not make it ERC1155NFT in the lootbox contract.');
    await (await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootboxAddress, tokenid, amount, '0x')).wait();
  } else if (type == 'ERC1155NFT') {
    await (await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootboxAddress, tokenid, 1, '0x')).wait();
  } else {
    throw new Error(`Unexpected reward type: ${type}`);
  }

  console.log(`Rewards supplied ${type}.`);
});

task('set-amountperunit', 'Set amount per unit of reward for a reward token')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('type', 'Reward token type, ERC20, ERC721, ERC1155 or ERC1155NFT', 'ERC721')
.addOptionalParam('tokenid', 'Reward token id, not needed for ERC20', 0, types.int)
.addOptionalParam('amountperunit', 'Reward token amount per reward unit', '1')
.setAction(async ({ factory, id, type, tokenid, amountperunit }) => {
  amountperunit = BigInt(amountperunit);
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier] = await ethers.getSigners();

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  const erc20 = await getContract('MockERC20', supplier, 0);
  const erc721 = await getContract('MockERC721', supplier, 1);
  const erc1155 = await getContract('MockERC1155', supplier, 2);
  const erc1155NFT = await getContract('MockERC1155NFT', supplier, 3);

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);

  let tokenAddress;
  if (type == 'ERC20') {
    tokenAddress = erc20.address;
  } else if (type == 'ERC721') {
    tokenAddress = erc721.address;
  } else if (type == 'ERC1155') {
    tokenAddress = erc1155.address;
  } else if (type == 'ERC1155NFT') {
    tokenAddress = erc1155NFT.address;
  } else {
    throw new Error(`Unexpected reward type: ${type}`);
  }
  const oldSupply = await lootbox.unitsSupply();
  await (await lootbox.connect(deployer).setAmountsPerUnit([tokenAddress], [tokenid], [amountperunit])).wait();
  const newSupply = await lootbox.unitsSupply();

  console.log(`Amount per unit updates. Old supply: ${oldSupply} new supply: ${newSupply}`);
});

task('set-price', 'Set the native currency price to buy a lootbox')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('price', 'An amount of native currency user needs to pay to get a single lootbox', '0.0001')
.setAction(async ({ factory, id, price }) => {
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier] = await ethers.getSigners();

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);

  const oldPrice = ethers.utils.formatUnits(await lootbox.getPrice());
  const parsedPrice = ethers.utils.parseUnits(price);
  await (await lootbox.connect(deployer).setPrice(parsedPrice)).wait();

  console.log(`Price set. Old price: ${oldPrice} new price: ${price}`);
});

task('mint', 'Mint lootboxes')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('user', 'User address that will receive lootboxes')
.addOptionalParam('tokenid', 'Token id that represents how many reward units each box will produce', 1, types.int)
.addOptionalParam('amount', 'How many lootboxes to mint', 5, types.int)
.setAction(async ({ factory, id, user: userAddr, tokenid, amount }) => {
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier, user] = await ethers.getSigners();

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  userAddr = userAddr || user.address;

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);

  await (await lootbox.connect(deployer)
    .mint(userAddr, tokenid, amount, '0x')).wait();

  console.log(`${amount} lootboxes worth of ${tokenid} reward units each minted to ${userAddr}`);
});

task('fulfill', 'Fulfill an open request to allocate rewards')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('user', 'User address that requested to open something')
.setAction(async ({ factory, id, user: userAddr, gas }) => {
  assert(network.name == 'localhost', 'Only for testing');
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');
  const { vrfV2Wrapper } = networkConfig[chainId];

  const [deployer, supplier, user] = await ethers.getSigners();

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  userAddr = userAddr || user.address;

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployer.address, id);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);
  const requestId = await lootbox.openerRequests(userAddr);
  assert(requestId.gt('0'), `Open request not found for user ${userAddr}`);

  const vrfW2WrapperInstance = await ethers.getContractAt('IVRFV2Wrapper', vrfV2Wrapper);
  const vrfV2Coordinator = await vrfW2WrapperInstance.COORDINATOR();
  await setBalance(vrfV2Coordinator, ethers.utils.parseUnits('10'));
  const impersonatedVRFCoordinator = await ethers.getImpersonatedSigner(vrfV2Coordinator);
  const randomWord = ethers.BigNumber.from(ethers.utils.randomBytes(32));
  await (await vrfW2WrapperInstance.connect(impersonatedVRFCoordinator)
    .rawFulfillRandomWords(requestId, [randomWord], { gasLimit: 10_000_000 })).wait();

  const requestIdAfter = await lootbox.openerRequests(userAddr);
  assert(requestIdAfter.eq('0'), `Randomness fulfillment ran out of gas, do recoverBoxes(opener)`);

  console.log(`Randomness fulfilled successfully`);
});

task('inventory', 'Get inventory')
.addOptionalParam('factory', 'LootboxFactory address')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('deployer', 'Wallet address that deployed the lootbox')
.setAction(async ({ factory, id, deployer: deployerAddress }) => {
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer, supplier] = await ethers.getSigners();
  deployerAddress = deployerAddress || deployer.address;

  const predictedAddress = ethers.utils.getContractAddress({
    from: deployerAddress,
    nonce: 0,
  });
  factory = factory || predictedAddress;

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployerAddress, id);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);

  const inventory = await lootbox.getInventory();
  console.log(util.inspect(inventory.result, false, null, true));
  console.log(util.inspect(inventory.leftoversResult, false, null, true));
});

task('devsetup', 'Do everything')
.setAction(async (taskArgs, hre) => {
  await hre.run('deploy-factory');
  await hre.run('deploy-lootbox');
  await hre.run('supply-rewards', { tokenid: 5 });
  await hre.run('supply-rewards', { tokenid: 1 });
  await hre.run('supply-rewards', { tokenid: 9 });
  await hre.run('supply-rewards', { type: 'ERC1155', tokenid: 3, amount: '50' });
  await hre.run('supply-rewards', { type: 'ERC1155', tokenid: 3, amount: '70' });
  await hre.run('supply-rewards', { type: 'ERC1155', tokenid: 4, amount: '150' });
  await hre.run('supply-rewards', { type: 'ERC1155NFT', tokenid: 2 });
  await hre.run('supply-rewards', { type: 'ERC1155NFT', tokenid: 6 });
  await hre.run('supply-rewards', { type: 'ERC20', amount: (1000n * 10n**18n).toString() });
  await hre.run('set-amountperunit', { type: 'ERC20', amountperunit: (30n * 10n**18n).toString() });
  await hre.run('set-amountperunit', { type: 'ERC1155', tokenid: 3, amountperunit: '35' });
  await hre.run('set-amountperunit', { type: 'ERC1155', tokenid: 4, amountperunit: '50' });
  await hre.run('set-price');
  await hre.run('mint', { tokenid: 1, amount: 5 });
  await hre.run('mint', { tokenid: 2, amount: 4 });
  await hre.run('mint', { tokenid: 3, amount: 3 });
  await hre.run('mint', { tokenid: 4, amount: 2 });
  await hre.run('mint', { tokenid: 5, amount: 1 });
  await hre.run('inventory');
});

task('deploy-test-tokens', 'Deploys test reward tokens, send them to the specified supplier address')
.addParam('supplier', 'Supplier address')
.addOptionalParam('verify', 'Verify the deployed factory', 'false', types.bool)
.setAction(async ({ supplier, verify }) => {
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [deployer] = await ethers.getSigners();

  const erc20 = await deploy('TestnetERC20', deployer, 10000n * 10n**18n, supplier);
  const erc721 = await deploy('TestnetERC721', deployer, 20, supplier);
  const erc1155 = await deploy('TestnetERC1155', deployer, 10, 1000, supplier);
  const erc1155NFT = await deploy('TestnetERC1155NFT', deployer, 15, supplier);

  if (verify === 'true') {
    console.log('Waiting half a minute to start verification');
    await sleep(30000);
    await hre.run('verify:verify', {
      address: erc20.address,
      constructorArguments: [10000n * 10n**18n, supplier],
      contract: 'contracts/testing/Mocks.sol:TestnetERC20',
    });
    await sleep(3000);
    await hre.run('verify:verify', {
      address: erc721.address,
      constructorArguments: [20, supplier],
      contract: 'contracts/testing/Mocks.sol:TestnetERC721',
    });
    await sleep(3000);
    await hre.run('verify:verify', {
      address: erc1155.address,
      constructorArguments: [10, 1000, supplier],
      contract: 'contracts/testing/Mocks.sol:TestnetERC1155',
    });
    await sleep(3000);
    await hre.run('verify:verify', {
      address: erc1155NFT.address,
      constructorArguments: [15, supplier],
      contract: 'contracts/testing/Mocks.sol:TestnetERC1155NFT',
    });
  }

  console.log('Test tokens:');
  console.log(`ERC20: ${erc20.address}`);
  console.log(`ERC721: ${erc721.address}`);
  console.log(`ERC1155: ${erc1155.address}`);
  console.log(`ERC1155NFT: ${erc1155NFT.address}`);
  console.log(`You can now use those tokens on ${supplier} wallet to test lootboxes.`);
});

task('supply-test-rewards', 'Transfer test rewards to the previously deployed lootbox contract')
.addParam('token', 'Address of the test reward token contract')
.addParam('factory', 'LootboxFactory address')
.addOptionalParam('deployer', 'Wallet address that deployed the lootbox')
.addOptionalParam('id', 'Lootbox id for contract address predictability', 0, types.int)
.addOptionalParam('type', 'Reward token type, ERC20, ERC721, ERC1155 or ERC1155NFT', 'ERC721')
.addOptionalParam('tokenid', 'Reward token id, not needed for ERC20', 0, types.int)
.addOptionalParam('amount', 'Reward token amount, not needed for ERC721 and ERC1155NFT', '1')
.setAction(async ({ factory, deployer: deployerAddress, id, type, token, tokenid, amount }) => {
  amount = BigInt(amount);
  const { chainId } = network.config;
  assert(chainId, 'Missing network configuration!');

  const [supplier] = await ethers.getSigners();
  deployerAddress = deployerAddress || supplier.address;

  const erc20 = await ethers.getContractAt('MockERC20', token);
  const erc721 = await ethers.getContractAt('MockERC721', token);
  const erc1155 = await ethers.getContractAt('MockERC1155', token);
  const erc1155NFT = await ethers.getContractAt('MockERC1155NFT', token);

  const lootboxFactory = await ethers.getContractAt('LootboxFactory', factory);
  const lootboxAddress = await lootboxFactory.getLootbox(deployerAddress, id);

  assert(lootboxAddress != ZERO_ADDRESS, `Lootbox with id ${id} and deployer ${deployerAddress} is not found.`);
  const lootbox = await ethers.getContractAt('LootboxInterface', lootboxAddress);
  assert(await lootbox.supplyAllowed(supplier.address), `Wallet ${supplier.address} is not allowed to supply rewards. Allowed: ${await lootbox.getSuppliers()}`);
  assert((await ethers.provider.getCode(token)).length > 2, `Token ${token} does not exist`);

  if (type == 'ERC20') {
    await (await erc20.connect(supplier).transfer(lootboxAddress, amount)).wait();
  } else if (type == 'ERC721') {
    await (await erc721.connect(supplier)['safeTransferFrom(address,address,uint256)'](supplier.address, lootboxAddress, tokenid)).wait();
  } else if (type == 'ERC1155') {
    assert(amount > 1, 'ERC1155 should be transferred in amount > 1 to not make it ERC1155NFT in the lootbox contract.');
    await (await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootboxAddress, tokenid, amount, '0x')).wait();
  } else if (type == 'ERC1155NFT') {
    await (await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootboxAddress, tokenid, 1, '0x')).wait();
  } else {
    throw new Error(`Unexpected reward type: ${type}`);
  }

  console.log(`Rewards supplied ${type}.`);
});

module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      evmVersion: 'paris',
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
      gasPrice: 100000000000,
      gas: 20000000,
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
      chainId: 1,
      url: process.env.MAINNET_URL || '',
      accounts:
        isSet(process.env.MAINNET_PRIVATE_KEY) ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
    sepolia: {
      chainId: 11155111,
      url: process.env.SEPOLIA_URL || '',
      accounts:
        isSet(process.env.SEPOLIA_PRIVATE_KEY) ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
    },
    fantomtest: {
      chainId: 4002,
      url: process.env.FANTOMTEST_URL || '',
      accounts:
        isSet(process.env.FANTOMTEST_PRIVATE_KEY) ? [process.env.FANTOMTEST_PRIVATE_KEY] : [],
    },
    fuji: {
      chainId: 43113,
      url: process.env.FUJI_URL || '',
      accounts:
        isSet(process.env.FUJI_PRIVATE_KEY) ? [process.env.FUJI_PRIVATE_KEY] : [],
    },
    mumbai: {
      chainId: 80001,
      url: process.env.MUMBAI_URL || '',
      accounts:
        isSet(process.env.MUMBAI_PRIVATE_KEY) ? [process.env.MUMBAI_PRIVATE_KEY] : [],
    },
    bsctest: {
      chainId: 97,
      url: process.env.BSCTEST_URL || '',
      accounts:
        isSet(process.env.BSCTEST_PRIVATE_KEY) ? [process.env.BSCTEST_PRIVATE_KEY] : [],
    },
    arbitest: {
      chainId: 421613,
      url: process.env.ARBITEST_URL || '',
      accounts:
        isSet(process.env.ARBITEST_PRIVATE_KEY) ? [process.env.ARBITEST_PRIVATE_KEY] : [],
    },
    fantom: {
      chainId: 250,
      url: process.env.FANTOM_URL || '',
      accounts:
        isSet(process.env.FANTOM_PRIVATE_KEY) ? [process.env.FANTOM_PRIVATE_KEY] : [],
      ledgerAccounts: isSet(process.env.LEDGER_ADDRESS) ? [process.env.LEDGER_ADDRESS] : [],
    },
    avax: {
      chainId: 43114,
      url: process.env.AVAX_URL || '',
      accounts:
        isSet(process.env.AVAX_PRIVATE_KEY) ? [process.env.AVAX_PRIVATE_KEY] : [],
      ledgerAccounts: isSet(process.env.LEDGER_ADDRESS) ? [process.env.LEDGER_ADDRESS] : [],
    },
    polygon: {
      chainId: 137,
      url: process.env.POLYGON_URL || '',
      accounts:
        isSet(process.env.POLYGON_PRIVATE_KEY) ? [process.env.POLYGON_PRIVATE_KEY] : [],
      ledgerAccounts: isSet(process.env.LEDGER_ADDRESS) ? [process.env.LEDGER_ADDRESS] : [],
    },
    bsc: {
      chainId: 56,
      url: process.env.BSC_URL || '',
      accounts:
        isSet(process.env.BSC_PRIVATE_KEY) ? [process.env.BSC_PRIVATE_KEY] : [],
      ledgerAccounts: isSet(process.env.LEDGER_ADDRESS) ? [process.env.LEDGER_ADDRESS] : [],
    },
  },
  gasReporter: {
    enabled: isSet(process.env.REPORT_GAS),
    currency: 'USD',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  docgen: {
    path: './docs',
    clear: true,
    runOnCompile: false,
  },
  mocha: {
    timeout: 100000,
  },
};
