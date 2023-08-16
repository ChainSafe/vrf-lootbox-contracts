const { loadFixture, setBalance } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { expect } = require('chai');
const { linkToken, vrfV2Wrapper, linkHolder } = require('../network.config.js')['31337'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const NOT_USED = 0;
const RewardType = {
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC1155NFT: 4,
};
const safeTransferFrom = 'safeTransferFrom(address,address,uint256)';
const IERC1155Receiver = '0x4e2312e0';
const IERC1155 = '0xd9b67a26';

const NFT = (id) => ({
  id,
  units: NOT_USED,
  amountPerUnit: NOT_USED,
  balance: NOT_USED,
});

describe('Lootbox', function () {
  const deploy = async (contractName, signer, ...params) => {
    const factory = await ethers.getContractFactory(contractName);
    const instance = await factory.connect(signer).deploy(...params);
    await instance.deployed();
    return instance;
  };

  const deployLootbox = async (linkAddress, wrapperAddress) => {
    const [owner, supplier, user] = await ethers.getSigners();
    const link = await ethers.getContractAt('LinkTokenInterface', linkAddress || linkToken);
    const factory = await deploy('LootboxFactory', owner, link.address, wrapperAddress || vrfV2Wrapper);

    const impersonatedLinkHolder = await ethers.getImpersonatedSigner(linkHolder);
    await link.connect(impersonatedLinkHolder)
      .transfer(owner.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(supplier.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(user.address, ethers.utils.parseUnits('10000'));

    await factory.deployLootbox('someUri', 0);
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    const lootbox = await ethers.getContractAt('Lootbox', deployedLootbox);

    const ADMIN = await lootbox.DEFAULT_ADMIN_ROLE();
    const MINTER = await lootbox.MINTER_ROLE();
    const PAUSER = await lootbox.PAUSER_ROLE();

    const erc20 = await deploy('MockERC20', supplier, 100000);
    const erc721 = await deploy('MockERC721', supplier, 20);
    const erc1155 = await deploy('MockERC1155', supplier, 10, 1000);
    const erc1155NFT = await deploy('MockERC1155NFT', supplier, 15);

    return { factory, lootbox, link, ADMIN, MINTER, PAUSER,
      erc20, erc721, erc1155, erc1155NFT };
  };

  const listRoleMembers = async (contract, role) => {
    const count = await contract.getRoleMemberCount(role);
    const members = [];
    for (let i = 0; i < count; i++) {
      members.push(await contract.getRoleMember(role, i));
    }
    return members;
  };

  const expectRoleMembers = async (lootbox, role, expected) => {
    const members = await listRoleMembers(lootbox, role);
    expect(members).to.eql(expected);
  };

  const expectEvents = async (tx, expectedCount) => {
    const receipt = await (await tx).wait();
    expect(receipt.events.length).to.equal(expectedCount);
    return expect(tx);
  };

  const parseInventory = (inventory) => inventory.map(el => ({
    rewardToken: el.rewardToken,
    rewardType: el.rewardType,
    units: el.units.toNumber(),
    amountPerUnit: el.amountPerUnit.toNumber(),
    balance: el.balance.toNumber(),
    extra: el.extra.map(extEl => ({
      id: extEl.id.toNumber(),
      units: extEl.units.toNumber(),
      amountPerUnit: extEl.amountPerUnit.toNumber(),
      balance: extEl.balance.toNumber(),
    })),
  }));

  const expectInventory = async (lootbox, expectedResult, expectedLeftovers) => {
    const inventory = await lootbox.getInventory();
    const actualResult = parseInventory(inventory.result);
    const actualLeftovers = parseInventory(inventory.leftoversResult);
    expect(actualResult, 'Unexpected inventory result').to.eql(expectedResult);
    expect(actualLeftovers, 'Unexpected leftovers result').to.eql(expectedLeftovers);
  };

  const expectLootboxTypes = async (lootbox, expectedTypes) => {
    expect((await lootbox.getLootboxTypes()).map(el => el.toNumber())).to.eql(expectedTypes);
  };

  it('should deploy lootbox and have valid defaults', async function () {
    const { lootbox, factory, ADMIN, MINTER, PAUSER } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    expect(await lootbox.getLink()).to.equal(linkToken);
    expect(await lootbox.getVRFV2Wrapper()).to.equal(vrfV2Wrapper);
    expect(await lootbox.uri(0)).to.equal('someUri');
    expect(await lootbox.FACTORY()).to.equal(factory.address);
    const wrapper = await ethers.getContractAt('IVRFV2Wrapper', vrfV2Wrapper);
    expect(await lootbox.LINK_ETH_FEED()).to.equal(await wrapper.LINK_ETH_FEED());
    await expectRoleMembers(lootbox, ADMIN, [owner.address]);
    await expectRoleMembers(lootbox, MINTER, [owner.address]);
    await expectRoleMembers(lootbox, PAUSER, [owner.address]);
    expect(await lootbox.getSuppliers()).to.eql([]);
    expect(await lootbox.getLootboxTypes()).to.eql([]);
    expect(await lootbox.getAllowedTokens()).to.eql([]);
    expect(await lootbox.getInventory()).to.eql([[], []]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });

  it('should allow admin to set base URI', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    await lootbox.setURI('newUri');
    expect(await lootbox.uri(0)).to.equal('newUri');
  });
  it('should restrict others to set base URI', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [_, other] = await ethers.getSigners();
    await expect(lootbox.connect(other).setURI('newUri'))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).setURI(''))
      .to.be.revertedWith(/AccessControl/);
  });

  it('should allow admin to add suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await expect(lootbox.addSuppliers([supplier.address]))
      .to.emit(lootbox, 'SupplierAdded')
      .withArgs(supplier.address);
    expect(await lootbox.getSuppliers()).to.eql([supplier.address]);
    await expect(lootbox.addSuppliers([user.address, owner.address]))
      .to.emit(lootbox, 'SupplierAdded')
      .withArgs(user.address)
      .to.emit(lootbox, 'SupplierAdded')
      .withArgs(owner.address);
    expect(await lootbox.getSuppliers()).to.eql([supplier.address, user.address, owner.address]);
  });
  it('should not emit events when adding duplicate suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addSuppliers([supplier.address]);
    await (await expectEvents(lootbox.addSuppliers([supplier.address, owner.address]), 1))
      .to.emit(lootbox, 'SupplierAdded')
      .withArgs(owner.address);
    expect(await lootbox.getSuppliers()).to.eql([supplier.address, owner.address]);
  });
  it('should restrict others to add suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [_, other] = await ethers.getSigners();
    await expect(lootbox.connect(other).addSuppliers([other.address]))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).addSuppliers([]))
      .to.be.revertedWith(/AccessControl/);
  });
  it('should allow admin to remove suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addSuppliers([supplier.address, user.address, owner.address]);
    await expect(lootbox.removeSuppliers([supplier.address]))
      .to.emit(lootbox, 'SupplierRemoved')
      .withArgs(supplier.address);
    expect(await lootbox.getSuppliers()).to.include.all.members([user.address, owner.address]);
    await expect(lootbox.removeSuppliers([user.address, owner.address]))
      .to.emit(lootbox, 'SupplierRemoved')
      .withArgs(user.address)
      .to.emit(lootbox, 'SupplierRemoved')
      .withArgs(owner.address);
    expect(await lootbox.getSuppliers()).to.eql([]);
  });
  it('should not emit events when removing absent suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addSuppliers([supplier.address, user.address, owner.address]);
    await lootbox.removeSuppliers([supplier.address]);
    await (await expectEvents(lootbox.removeSuppliers([supplier.address, user.address, owner.address]), 2))
      .to.emit(lootbox, 'SupplierRemoved')
      .withArgs(user.address)
      .to.emit(lootbox, 'SupplierRemoved')
      .withArgs(owner.address);
    expect(await lootbox.getSuppliers()).to.eql([]);
  });
  it('should restrict others to remove suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, other] = await ethers.getSigners();
    await lootbox.addSuppliers([other.address]);
    await expect(lootbox.connect(other).removeSuppliers([other.address]))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).removeSuppliers([owner.address]))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).removeSuppliers([]))
      .to.be.revertedWith(/AccessControl/);
  });
  it('should list suppliers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addSuppliers([supplier.address, user.address, owner.address]);
    expect(await lootbox.getSuppliers()).to.eql([supplier.address, user.address, owner.address]);
  });

  it('should allow admin to allow tokens', async function () {
    const { lootbox, erc20, erc721, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await expect(lootbox.addTokens([erc20.address]))
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc20.address);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address]);
    await expect(lootbox.addTokens([erc721.address, erc1155.address]))
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc721.address)
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc1155.address);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address, erc721.address, erc1155.address]);
  });
  it('should not emit events when allowing duplicate tokens', async function () {
    const { lootbox, erc20, erc721, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await (await expectEvents(lootbox.addTokens([erc721.address, erc20.address]), 1))
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc721.address);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address, erc721.address]);
  });
  it('should restrict others to allow tokens', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [_, other] = await ethers.getSigners();
    await expect(lootbox.connect(other).addTokens([other.address]))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).addTokens([]))
      .to.be.revertedWith(/AccessControl/);
  });
  it('should list tokens', async function () {
    const { lootbox, erc20, erc721, erc1155 } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address, erc721.address, erc1155.address]);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address, erc721.address, erc1155.address]);
  });

  it('should allow admin to withdraw native currency', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    await setBalance(lootbox.address, 100);
    await expect(lootbox.withdraw())
      .to.changeEtherBalance(owner.address, 100)
      .to.changeEtherBalance(lootbox.address, -100);
  });
  it('should restrict others to withdraw native currency', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [_, other] = await ethers.getSigners();
    await expect(lootbox.connect(other).withdraw())
      .to.be.revertedWith(/AccessControl/);
    await setBalance(lootbox.address, 100);
    await expect(lootbox.connect(other).withdraw())
      .to.be.revertedWith(/AccessControl/);
  });

  it.skip('should allow admin to withdraw allowed ERC20 from inventory', async function () {});
  it.skip('should allow admin to withdraw allowed ERC20 from leftovers', async function () {});
  it.skip('should allow admin to withdraw restricted ERC20', async function () {});
  it.skip('should allow admin to emergency withdraw allowed ERC20', async function () {});

  it.skip('should allow admin to withdraw allowed ERC721 from inventory', async function () {});
  it.skip('should allow admin to withdraw allowed ERC721 from leftovers', async function () {});
  it.skip('should allow admin to withdraw restricted ERC721', async function () {});
  it.skip('should allow admin to emergency withdraw allowed ERC721', async function () {});

  it.skip('should allow admin to withdraw allowed ERC1155 from inventory', async function () {});
  it.skip('should allow admin to withdraw allowed ERC1155 from leftovers', async function () {});
  it.skip('should allow admin to emergency withdraw allowed ERC1155', async function () {});

  it.skip('should allow admin to withdraw allowed ERC1155 NFT from inventory', async function () {});
  it.skip('should allow admin to withdraw allowed ERC1155 NFT from leftovers', async function () {});
  it.skip('should allow admin to emergency withdraw allowed ERC1155 NFT', async function () {});

  it.skip('should restrict others to withdraw assets', async function () {});

  it('should restrict admin to set amounts per unit for a disallowed token', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await erc20.connect(supplier).transfer(lootbox.address, 200);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [0]))
      .to.be.revertedWithCustomError(lootbox, 'TokenDenied')
      .withArgs(erc20.address);
  });
  it('should allow admin to set amounts per unit for ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 10;
    const expectedUnits = 100;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: totalAmount,
      extra: [],
    }];
    const expectedLeftovers = [];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc20.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it('should allow admin to set amounts per unit for ERC20 to 0', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 0;
    const expectedUnits = 0;
    const expectedInventory = [];
    const expectedLeftovers = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: totalAmount,
      extra: [],
    }];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc20.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 20;
    const expectedUnits = 50;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: totalAmount,
      extra: [],
    }];
    const expectedLeftovers = [];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc20.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC20 to 0', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 0;
    const expectedUnits = 0;
    const expectedInventory = [];
    const expectedLeftovers = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: totalAmount,
      extra: [],
    }];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc20.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC20', async function () {});
  it('should show remainder amount of tokens for ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 3;
    const expectedUnits = 333;
    const expectedBalance = 999;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: expectedBalance,
      extra: [],
    }];
    const expectedLeftoversAmount = 1;
    const expectedLeftovers = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: amountPerUnit,
      balance: expectedLeftoversAmount,
      extra: [],
    }];
    const extraDeposit = 200;
    const extraExpectedLeftoversAmount = 201;
    const extraExpectedLeftovers = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: amountPerUnit,
      balance: extraExpectedLeftoversAmount,
      extra: [],
    }];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc20.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    await erc20.connect(supplier).transfer(lootbox.address, extraDeposit);
    await expectInventory(lootbox, expectedInventory, extraExpectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it('should restrict admin to set amounts per unit ERC20 that was not deposited yet', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [0]))
      .to.be.revertedWithCustomError(lootbox, 'NoTokens');
  });
  it('should restrict others to set amounts per unit ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.connect(supplier).setAmountsPerUnit([erc20.address], [NOT_USED], [0]))
      .to.be.revertedWith(/AccessControl/);
  });

  it('should allow admin to set amounts per unit for ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const expectedLeftovers = [];
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(1);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 3);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 2,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(2);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 2);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(3);
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [1]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, 1, 3);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(3);
    const amountPerUnit = 2;
    const expectedUnits = 1;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 8);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 2,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2), NFT(8)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(2);
  });
  it('should allow admin to set amounts per unit for ERC721 to 0', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const expectedInventory = [];
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    const amountPerUnit = 0;
    const expectedUnits = 0;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 3);
    await expectInventory(lootbox, expectedInventory, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    const newAmountPerUnit = 1;
    const newExpectedUnits = 2;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [newAmountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, newAmountPerUnit, newExpectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: newExpectedUnits,
      amountPerUnit: newAmountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(newExpectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 2);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    const amountPerUnit = 2;
    const expectedUnits = 1;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    const newAmountPerUnit = 1;
    const newExpectedUnits = 3;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [newAmountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, newAmountPerUnit, newExpectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: newExpectedUnits,
      amountPerUnit: newAmountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(newExpectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC721 to 0', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 2);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    await lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [2]);
    const amountPerUnit = 0;
    const expectedUnits = 0;
    await expect(lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc721.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [], [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC721', async function () {});
  it('should show remainder amount of tokens for ERC721', async function () {
    // Covered by: should allow admin to reset amounts per unit for ERC721 to 0
  });
  it('should restrict others to set amounts per unit ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await expect(lootbox.connect(supplier).setAmountsPerUnit([erc721.address], [NOT_USED], [1]))
      .to.be.revertedWith(/AccessControl/);
  });

  it('should allow admin to set amounts per unit for ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const expectedLeftovers = [];
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(1);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 3, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 2,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(2);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(3);
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [1]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, 1, 3);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(3);
    const amountPerUnit = 2;
    const expectedUnits = 1;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 8, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 2,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2), NFT(8)],
    }], expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(2);
  });
  it('should allow admin to set amounts per unit for ERC1155 NFT to 0', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    const expectedInventory = [];
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    const amountPerUnit = 0;
    const expectedUnits = 0;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, expectedInventory, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 3, 1, '0x');
    await expectInventory(lootbox, expectedInventory, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    const newAmountPerUnit = 1;
    const newExpectedUnits = 2;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [newAmountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, newAmountPerUnit, newExpectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: newExpectedUnits,
      amountPerUnit: newAmountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(newExpectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 5, 1, '0x');
    const amountPerUnit = 2;
    const expectedUnits = 1;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    const newAmountPerUnit = 1;
    const newExpectedUnits = 3;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [newAmountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, newAmountPerUnit, newExpectedUnits);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: newExpectedUnits,
      amountPerUnit: newAmountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(newExpectedUnits);
  });
  it('should allow admin to reset amounts per unit for ERC1155 NFT to 0', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 5, 1, '0x');
    await lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [2]);
    const amountPerUnit = 0;
    const expectedUnits = 0;
    await expect(lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [amountPerUnit]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155NFT.address, 0, amountPerUnit, expectedUnits);
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: NOT_USED,
      extra: [NFT(0), NFT(2), NFT(5)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC1155 NFT', async function () {});
  it('should show remainder amount of tokens for ERC1155 NFT', async function () {
    // Covered by: should allow admin to reset amounts per unit for ERC1155 NFT to 0
  });
  it('should restrict others to set amounts per unit ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(lootbox.connect(supplier).setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [1]))
      .to.be.revertedWith(/AccessControl/);
  });

  it('should allow admin to set amounts per unit for ERC1155 per ID', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 0,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 0,
        balance: 100,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    await expect(lootbox.setAmountsPerUnit([erc1155.address], [0], [0]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 0, 0);
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 0,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 0,
        balance: 100,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 200, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 0,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 0,
        balance: 100,
      }, {
        id: 2,
        units: 0,
        amountPerUnit: 0,
        balance: 200,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    await expect(lootbox.setAmountsPerUnit([erc1155.address], [0], [5]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 5, 20);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 20,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 20,
        amountPerUnit: 5,
        balance: 100,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 2,
        units: 0,
        amountPerUnit: 0,
        balance: 200,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(20);
    await expect(lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [5, 40]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 5, 20)
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 2, 40, 25);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 25,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 20,
        amountPerUnit: 5,
        balance: 100,
      }, {
        id: 2,
        units: 5,
        amountPerUnit: 40,
        balance: 200,
      }],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(25);
  });
  it('should allow admin to set amounts per unit for ERC1155 to 0 per ID', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 200, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [5, 40]);
    await expect(lootbox.setAmountsPerUnit([erc1155.address], [0], [0]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 0, 5);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 5,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 2,
        units: 5,
        amountPerUnit: 40,
        balance: 200,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 0,
        balance: 100,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(5);
    await expect(lootbox.setAmountsPerUnit([erc1155.address], [0], [101]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 101, 5);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 5,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 2,
        units: 5,
        amountPerUnit: 40,
        balance: 200,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 101,
        balance: 100,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(5);
  });
  it('should allow admin to reset amounts per unit for ERC1155 per ID', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 200, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [5, 40]);
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [2, 0], [100, 10]);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 12,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 10,
        amountPerUnit: 10,
        balance: 100,
      }, {
        id: 2,
        units: 2,
        amountPerUnit: 100,
        balance: 200,
      }],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(12);
  });
  it('should allow admin to reset amounts per unit for ERC1155 to 0 per ID', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 200, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [5, 40]);
    await expect(lootbox.setAmountsPerUnit([erc1155.address], [0], [0]))
      .to.emit(lootbox, 'AmountPerUnitSet')
      .withArgs(erc1155.address, 0, 0, 5);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 5,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 2,
        units: 5,
        amountPerUnit: 40,
        balance: 200,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 0,
        amountPerUnit: 0,
        balance: 100,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(5);
  });
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC1155 per ID', async function () {});
  it('should show remainder amount of tokens for ERC1155 per ID', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 200, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [5, 40]);
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 2], [30, 60]);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 6,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 3,
        amountPerUnit: 30,
        balance: 90,
      }, {
        id: 2,
        units: 3,
        amountPerUnit: 60,
        balance: 180,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 30,
        balance: 10,
      }, {
        id: 2,
        units: NOT_USED,
        amountPerUnit: 60,
        balance: 20,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(6);
  });
  it('should restrict others to set amounts per unit ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 100, '0x');
    await expect(lootbox.connect(supplier).setAmountsPerUnit([erc1155.address], [NOT_USED], [10]))
      .to.be.revertedWith(/AccessControl/);
  });

  it('should allow supplier to supply allowed ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
  });
  it('should restrict others to supply allowed ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, other.address, 0);
    await expect(erc721.connect(other)[safeTransferFrom](other.address, lootbox.address, 0))
      .to.be.revertedWithCustomError(lootbox, 'SupplyDenied')
      .withArgs(other.address);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 3);
    await expect(erc721.connect(other)[safeTransferFrom](other.address, lootbox.address, 0))
      .to.be.revertedWithCustomError(lootbox, 'SupplyDenied')
      .withArgs(other.address);
  });
  it('should restrict supplier to supply disalowed ERC721', async function () {
    const { lootbox, erc721, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0))
      .to.be.revertedWithCustomError(lootbox, 'TokenDenied')
      .withArgs(erc721.address);
  });
  it('should allow supplier to resupply ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 3);
  });
  it('should restrict supplier to supply ERC721 if it was already assigned a different type', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier).transferFrom(supplier.address, lootbox.address, 0);
    await lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [1]); // This should mark it as ERC20.
    await expect(erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1))
      .to.be.revertedWithCustomError(lootbox, 'ModifiedRewardType')
      .withArgs(RewardType.ERC20, RewardType.ERC721);
  });
  it('should put first time supplied ERC721 straight into inventory with 1 reward per unit', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(1);
  });

  it('should allow supplier to supply single allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
  });
  it('should restrict others to supply single allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, other.address, 1, 1, '0x');
    await expect(erc1155NFT.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155NFT.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply single disalowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply single ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
  });
  it('should restrict supplier to supply single ERC1155 NFT if it was already assigned a different type', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155NFT.address, ethers.utils.parseUnits('1'));
    const erc1155NFTSigner = await ethers.getImpersonatedSigner(erc1155NFT.address);
    await lootbox.connect(erc1155NFTSigner).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied single ERC1155 NFT straight into inventory with 1 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(1);
  });
  it('should put resupplied single ERC1155 NFT into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [0]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });
  it('should restrict supplier to resupply single ERC1155 NFT if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
  });
  it('should restrict supplier to supply single ERC1155 NFT with value > 1', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 2, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
  });
  it('should restrict supplier to supply single ERC1155 NFT with zero value', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });

  it('should allow supplier to supply multiple allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
  });
  it('should restrict others to supply multiple allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, other.address, 1, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, other.address, 2, 1, '0x');
    await expect(erc1155NFT.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155NFT.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(other).safeTransferFrom(other.address, lootbox.address, 2, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple disalowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply multiple ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
  });
  it('should restrict supplier to supply multiple ERC1155 NFT if it was already assigned a different type', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155NFT.address, ethers.utils.parseUnits('1'));
    const erc1155NFTSigner = await ethers.getImpersonatedSigner(erc1155NFT.address);
    await lootbox.connect(erc1155NFTSigner).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied multiple ERC1155 NFT straight into inventory with 1 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 2,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(2);
  });
  it('should put resupplied multiple ERC1155 NFT into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [0]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1), NFT(2)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });
  it('should restrict supplier to resupply multiple ERC1155 NFT if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple ERC1155 NFT with value > 1', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 2, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 2, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple ERC1155 NFT with zero value', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await expect(erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
  });

  it('should allow supplier to supply single allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 5, '0x');
  });
  it('should restrict others to supply single allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, other.address, 0, 10, '0x');
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply single disalowed ERC1155', async function () {
    const { lootbox, erc1155, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply single ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [11]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 5, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 6, '0x');
  });
  it('should restrict supplier to supply single ERC1155 if it was already assigned a different type', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155.address, ethers.utils.parseUnits('1'));
    const erc1155Signer = await ethers.getImpersonatedSigner(erc1155.address);
    await lootbox.connect(erc1155Signer).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied single ERC1155 into leftovers with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 11,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });
  it('should put resupplied single ERC1155 into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [0]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 8, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 19,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });
  it('should put resupplied single ERC1155 into leftovers if there is a remainder', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [10]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 8, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 1,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 1,
        amountPerUnit: 10,
        balance: 10,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 10,
        balance: 9,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(1);
  });
  it('should allow supplier to resupply single ERC1155 if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 2, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
  });
  it('should restrict supplier to supply single ERC1155 with zero value', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 2, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
  });

  it('should allow supplier to supply multiple allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 5, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 8, '0x');
  });
  it('should restrict others to supply multiple allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, other.address, 0, 10, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, other.address, 1, 5, '0x');
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 2, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(other).safeTransferFrom(other.address, lootbox.address, 1, 5, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple disalowed ERC1155', async function () {
    const { lootbox, erc1155, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 20, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply multiple ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 13, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 33, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [11, 13]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 13, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 33, '0x');
  });
  it('should restrict supplier to supply multiple ERC1155 if it was already assigned a different type', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155.address, ethers.utils.parseUnits('1'));
    const erc1155Signer = await ethers.getImpersonatedSigner(erc1155.address);
    await lootbox.connect(erc1155Signer).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied multiple ERC1155 into leftovers with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 13, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [11]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 33, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 1,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 1,
        amountPerUnit: 11,
        balance: 11,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 1,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 13,
      }, {
        id: 2,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 33,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(1);
  });
  it('should put resupplied multiple ERC1155 into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 13, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [0, 0]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 8, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 10, '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 19,
      }, {
        id: 1,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 23,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
  });
  it('should put resupplied multiple ERC1155 into leftovers if there is a remainder', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 11, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 13, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [10, 12]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 8, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 10, '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 2,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 1,
        amountPerUnit: 10,
        balance: 10,
      }, {
        id: 1,
        units: 1,
        amountPerUnit: 12,
        balance: 12,
      }],
    }], [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: NOT_USED,
        amountPerUnit: 10,
        balance: 9,
      }, {
        id: 1,
        units: NOT_USED,
        amountPerUnit: 12,
        balance: 11,
      }],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(2);
  });
  it('should allow supplier to resupply multiple ERC1155 if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 2, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 10, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 20, '0x');
  });
  it('should restrict supplier to supply multiple ERC1155 with zero value', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 2, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await expect(erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 0, '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });

  it('should allow minter to mint lootboxes', async function () {
    const { lootbox, MINTER } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await lootbox.mint(user.address, 1, 10, '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(10);
    expect(await lootbox.boxedUnits()).to.equal(10);
    await lootbox.mintBatch(user.address, [2], [4], '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(10);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(4);
    expect(await lootbox.boxedUnits()).to.equal(18);
    await lootbox.grantRole(MINTER, other.address);
    await lootbox.connect(other).mintBatch(user.address, [3, 1], [4, 2], '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(12);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(4);
    expect(await lootbox.balanceOf(user.address, 3)).to.equal(4);
    expect(await lootbox.boxedUnits()).to.equal(32);
  });
  it('should restrict others to mint lootboxes', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.connect(other).mint(user.address, 1, 10, '0x'))
      .to.be.revertedWith(/role/);
  });
  it('should restrict minting of 0 id lootboxes', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.mint(user.address, 0, 1, '0x'))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mint(user.address, 0, 10, '0x'))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
  });
  it('should restrict minting of 256+ id lootboxes', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.mint(user.address, 256, 1, '0x'))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mint(user.address, 256, 10, '0x'))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mint(user.address, 1000, 1, '0x'))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
  });
  it('should support IERC1155Receiver interface', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    expect(await lootbox.supportsInterface(IERC1155Receiver)).to.be.true;
  });
  it('should support IERC1155 interface', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    expect(await lootbox.supportsInterface(IERC1155)).to.be.true;
  });
  it('should list lootbox types', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [3, 1], [4, 2], '0x');
    await lootbox.mintBatch(user.address, [2, 4], [4, 2], '0x');
    await lootbox.mintBatch(user.address, [2, 4], [4, 2], '0x');
    await expectLootboxTypes(lootbox, [3, 1, 2, 4]);
  });

  it.only('should calculate open price based on the gas, VRF and LINK price and fee per unit', async function () {});

  it.skip('should recover lootboxes from an own failed open request', async function () {});
  it.skip('should recover lootboxes from another opener failed request', async function () {});
  it.skip('should not recover lootboxes if there is no request for an opener', async function () {});
  it.skip('should not recover lootboxes if the request is not failed for an opener', async function () {});
  it.skip('should not recover lootboxes after a successful recovery', async function () {});

  it.skip('should claim own allocated rewards', async function () {});
  it.skip('should claim another opener allocated rewards', async function () {});
  it.skip('should restrict claiming if paused', async function () {});
  it.skip('should claim another opener allocated ERC20 rewards', async function () {});
  it.skip('should claim another opener allocated ERC721 rewards', async function () {});
  it.skip('should claim another opener allocated ERC1155 NFT rewards', async function () {});
  it.skip('should claim another opener allocated ERC1155 rewards', async function () {});

  it.skip('should restrict calling allocate rewards for not the contract itself', async function () {});
  it.skip('should restrict calling raw fulfill random words for not the VRF_V2_WRAPPER', async function () {});
  it.skip('should restrict rewards allocation for a failed request', async function () {});
  it.skip('should restrict rewards allocation for an absent request', async function () {});
  it.skip('should restrict rewards allocation for a fulfilled request', async function () {});

  it.skip('should allow LINK as ERC677 transfer and call to create an open request', async function () {});
  it.skip('should restrict other tokens as ERC677 transfer and call', async function () {});
  it.skip('should restrict to create an open request with LINK payment less than VRF price', async function () {});
  it.skip('should restrict to create an open request with LINK payment less than VRF price plus LINK factory fee', async function () {});
  it.skip('should forward the open fee in LINK to the factory when creating an open request', async function () {});
  it.skip('should not forward a zero fee in LINK to the factory when creating an open request', async function () {});
  it.skip('should return the excess LINK to the opener when creating an open request', async function () {});

  it.skip('should allow native currency payment to create an open request', async function () {});
  it.skip('should restrict native currency deposit outside of open function', async function () {});
  it.skip('should restrict to create an open request with native payment less than VRF native price', async function () {});
  it.skip('should restrict to create an open request with native payment less than VRF native price plus factory fee', async function () {});
  it.skip('should forward the native open fee to the factory when creating an open request', async function () {});
  it.skip('should not forward a zero native fee in to the factory when creating an open request', async function () {});
  it.skip('should return the excess native payment to the opener when creating an open request', async function () {});

  describe('LINK payment', function() {
    it.skip('should restrict more then one pending open request per opener', async function () {});
    it.skip('should restrict open request with less than 100,000 gas for VRF request', async function () {});
    it.skip('should restrict open request when paused', async function () {});
    it.skip('should restrict open with zero total units', async function () {});
    it.skip('should restrict open with total units less than supply', async function () {});
    it.skip('should burn boxes specified in open request', async function () {});

    it.skip('should allocate ERC20 rewards', async function () {});
    it.skip('should allocate ERC721 rewards', async function () {});
    it.skip('should allocate ERC1155 rewards', async function () {});
    it.skip('should allocate ERC1155 NFT rewards', async function () {});
    it.skip('should allocate all rewards', async function () {});
    it.skip('should move remainder of ERC721 rewards to leftovers', async function () {});
    it.skip('should move remainder of ERC1155 NFT rewards to leftovers', async function () {});
  });

  describe('Native currency payment', function() {
    it.skip('should restrict more then one pending open request per opener', async function () {});
    it.skip('should restrict open request with less than 100,000 gas for VRF request', async function () {});
    it.skip('should restrict open request when paused', async function () {});
    it.skip('should restrict open with zero total units', async function () {});
    it.skip('should restrict open with total units less than supply', async function () {});
    it.skip('should burn boxes specified in open request', async function () {});

    it.skip('should allocate ERC20 rewards', async function () {});
    it.skip('should allocate ERC721 rewards', async function () {});
    it.skip('should allocate ERC1155 rewards', async function () {});
    it.skip('should allocate ERC1155 NFT rewards', async function () {});
    it.skip('should allocate all rewards', async function () {});
    it.skip('should move remainder of ERC721 rewards to leftovers', async function () {});
    it.skip('should move remainder of ERC1155 NFT rewards to leftovers', async function () {});
  });
});
