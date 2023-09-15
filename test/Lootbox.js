const { loadFixture, setBalance } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const sort = require('sort-any');
const chai = require('chai');
const { expect } = chai;
const { linkToken, vrfV2Wrapper, linkHolder } = require('../network.config.js')['31337'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LINK_UNIT = '1000000000000000000';
const NOT_USED = 0;
const RewardType = {
  UNSET: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC1155NFT: 4,
};
const safeTransferFrom = 'safeTransferFrom(address,address,uint256)';
const IERC1155Receiver = '0x4e2312e0';
const IERC1155 = '0xd9b67a26';
const REQUEST_GAS_LIMIT = 1000000;

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
    const wrapper = wrapperAddress || vrfV2Wrapper;
    const [owner, supplier, user] = await ethers.getSigners();
    const link = await ethers.getContractAt('LinkTokenInterface', linkAddress || linkToken);
    const factory = await deploy('LootboxFactory', owner, link.address, wrapper);

    const impersonatedLinkHolder = await ethers.getImpersonatedSigner(linkHolder);
    await link.connect(impersonatedLinkHolder)
      .transfer(owner.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(supplier.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(user.address, ethers.utils.parseUnits('10000'));

    await factory.deployLootbox('someUri', 0);
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    const lootbox = await ethers.getContractAt('LootboxInterface', deployedLootbox);
    const ethLinkFeedAddress = await lootbox.LINK_ETH_FEED();
    const ethLinkFeed = await ethers.getContractAt('AggregatorV3Interface', ethLinkFeedAddress);
    const ethLinkPrice = (await ethLinkFeed.latestRoundData())[1];
    const vrfWrapper = await ethers.getContractAt('IVRFV2Wrapper', wrapper);
    const vrfPrice1M = await vrfWrapper.estimateRequestPrice(REQUEST_GAS_LIMIT, network.config.gasPrice);
    const vrfCoordinator = await ethers.getImpersonatedSigner(await vrfWrapper.COORDINATOR());
    const vrfWrapperSigner = await ethers.getImpersonatedSigner(vrfWrapper.address);
    await setBalance(vrfCoordinator.address, ethers.utils.parseUnits('100'));
    await setBalance(vrfWrapperSigner.address, ethers.utils.parseUnits('100'));

    const ADMIN = await lootbox.DEFAULT_ADMIN_ROLE();
    const MINTER = await lootbox.MINTER_ROLE();
    const PAUSER = await lootbox.PAUSER_ROLE();

    const erc20 = await deploy('MockERC20', supplier, 100000);
    const erc721 = await deploy('MockERC721', supplier, 20);
    const erc1155 = await deploy('MockERC1155', supplier, 10, 1000);
    const erc1155NFT = await deploy('MockERC1155NFT', supplier, 15);

    return { factory, lootbox, link, ADMIN, MINTER, PAUSER,
      erc20, erc721, erc1155, erc1155NFT, ethLinkPrice, vrfPrice1M,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner };
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

  const bnToNumber = (list) => {
    return list.map(el => {
      if (Array.isArray(el)) {
        return bnToNumber(el);
      }
      return el && el._isBigNumber && el.lt(Number.MAX_SAFE_INTEGER.toString()) ? el.toNumber() : el;
    });
  };

  const expectContractEvents = async (tx, contract, expectedEvents) => {
    const receipt = await (await tx).wait();
    const events = receipt.events.filter(event => event.address == contract.address)
      .map(event => contract.interface.parseLog(event));
    expect(events.length).to.equal(expectedEvents.length);
    events.forEach((event, index) => {
      expect(event.name).to.equal(expectedEvents[index][0]);
      expect(bnToNumber(event.args)).to.eql(expectedEvents[index].slice(1));
    });
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
    expect(sort(actualResult), 'Unexpected inventory result').to.deep.eql(sort(expectedResult));
    expect(sort(actualLeftovers), 'Unexpected leftovers result').to.deep.eql(sort(expectedLeftovers));
  };

  const expectLootboxTypes = async (lootbox, expectedTypes) => {
    expect((await lootbox.getLootboxTypes()).map(el => el.toNumber())).to.eql(expectedTypes);
  };

  const expectRequest = async (lootbox, opener, ...expectedRequest) => {
    const request = await lootbox.getOpenerRequestDetails(opener);
    expect(request.opener).to.equal(expectedRequest[0]);
    expect(request.unitsToGet).to.equal(expectedRequest[1]);
    expect(bnToNumber(request.lootIds), 'Unexpected lootIds').to.eql(expectedRequest[2]);
    expect(bnToNumber(request.lootAmounts), 'Unexpected lootAmounts').to.eql(expectedRequest[3]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([]);
    expect(await lootbox.getInventory()).to.eql([[], []]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.unitsMinted()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.UNSET]);
    await expect(lootbox.addTokens([erc721.address, erc1155.address]))
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc721.address)
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc1155.address);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address, erc721.address, erc1155.address]);
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.UNSET, RewardType.UNSET, RewardType.UNSET]);
  });
  it('should not emit events when allowing duplicate tokens', async function () {
    const { lootbox, erc20, erc721, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await (await expectEvents(lootbox.addTokens([erc721.address, erc20.address]), 1))
      .to.emit(lootbox, 'TokenAdded')
      .withArgs(erc721.address);
    expect(await lootbox.getAllowedTokens()).to.eql([erc20.address, erc721.address]);
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.UNSET, RewardType.UNSET]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.UNSET, RewardType.UNSET, RewardType.UNSET]);
  });

  it('should allow admin to withdraw native currency', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, other] = await ethers.getSigners();
    await setBalance(lootbox.address, 100);
    await expect(lootbox.withdraw(ZERO_ADDRESS, owner.address, 100))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(ZERO_ADDRESS, owner.address, 100)
      .to.changeEtherBalance(owner.address, 100)
      .to.changeEtherBalance(lootbox.address, -100);
    await setBalance(lootbox.address, 100);
    await expect(lootbox.withdraw(ZERO_ADDRESS, ZERO_ADDRESS, 100))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(ZERO_ADDRESS, owner.address, 100)
      .to.changeEtherBalance(owner.address, 100)
      .to.changeEtherBalance(lootbox.address, -100);
    await setBalance(lootbox.address, 100);
    await expect(lootbox.withdraw(ZERO_ADDRESS, owner.address, 0))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(ZERO_ADDRESS, owner.address, 100)
      .to.changeEtherBalance(owner.address, 100)
      .to.changeEtherBalance(lootbox.address, -100);
    await setBalance(lootbox.address, 100);
    await expect(lootbox.withdraw(ZERO_ADDRESS, other.address, 30))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(ZERO_ADDRESS, other.address, 30)
      .to.changeEtherBalance(owner.address, 0)
      .to.changeEtherBalance(other.address, 30)
      .to.changeEtherBalance(lootbox.address, -30);
  });
  it('should allow admin to withdraw ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await setBalance(lootbox.address, 100);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.withdraw(erc20.address, owner.address, 100))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(erc20.address, owner.address, 100)
      .to.changeEtherBalance(owner.address, 0)
      .to.changeEtherBalance(lootbox.address, 0)
      .to.changeTokenBalance(erc20, owner.address, 100)
      .to.changeTokenBalance(erc20, lootbox.address, -100);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.withdraw(erc20.address, ZERO_ADDRESS, 100))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(erc20.address, owner.address, 100)
      .to.changeTokenBalance(erc20, owner.address, 100)
      .to.changeTokenBalance(erc20, lootbox.address, -100);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.withdraw(erc20.address, owner.address, 0))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(erc20.address, owner.address, 100)
      .to.changeTokenBalance(erc20, owner.address, 100)
      .to.changeTokenBalance(erc20, lootbox.address, -100);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.withdraw(erc20.address, other.address, 30))
      .to.emit(lootbox, 'Withdraw')
      .withArgs(erc20.address, other.address, 30)
      .to.changeTokenBalance(erc20, owner.address, 0)
      .to.changeTokenBalance(erc20, other.address, 30)
      .to.changeTokenBalance(erc20, lootbox.address, -30);
  });
  it('should restrict admin to withdraw allowed ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await setBalance(lootbox.address, 100);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.addTokens([erc20.address]);
    await expect(lootbox.withdraw(erc20.address, owner.address, 100))
      .to.revertedWithCustomError(lootbox, 'RewardWithdrawalDenied')
      .withArgs(erc20.address);
    await expect(lootbox.withdraw(erc20.address, ZERO_ADDRESS, 100))
      .to.revertedWithCustomError(lootbox, 'RewardWithdrawalDenied')
      .withArgs(erc20.address);
    await expect(lootbox.withdraw(erc20.address, owner.address, 0))
      .to.revertedWithCustomError(lootbox, 'RewardWithdrawalDenied')
      .withArgs(erc20.address);
    await expect(lootbox.withdraw(erc20.address, other.address, 30))
      .to.revertedWithCustomError(lootbox, 'RewardWithdrawalDenied')
      .withArgs(erc20.address);
  });
  it('should restrict others to withdraw native currency', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await setBalance(lootbox.address, 100);
    await expect(lootbox.connect(other).withdraw(ZERO_ADDRESS, owner.address, 100))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(supplier).withdraw(ZERO_ADDRESS, other.address, 0))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(supplier).withdraw(ZERO_ADDRESS, ZERO_ADDRESS, 0))
      .to.be.revertedWith(/AccessControl/);
  });
  it('should restrict others to withdraw ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await expect(lootbox.connect(other).withdraw(erc20.address, owner.address, 100))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(supplier).withdraw(erc20.address, other.address, 0))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(supplier).withdraw(erc20.address, ZERO_ADDRESS, 0))
      .to.be.revertedWith(/AccessControl/);
  });

  // it.skip('should allow admin to withdraw allowed ERC20 from inventory', async function () {});
  // it.skip('should allow admin to withdraw allowed ERC20 from leftovers', async function () {});
  // it.skip('should allow admin to withdraw restricted ERC20', async function () {});
  it('should allow admin to emergency withdraw ERC20', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const totalAmount = 1000;
    const amountPerUnit = 11;
    const expectedUnits = 90;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: 990,
      extra: [],
    }];
    const expectedLeftovers = [];
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await erc20extra.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    let tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, supplier.address, [0], [300]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, supplier.address, [0], [300]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, supplier.address, 300)
      .to.changeTokenBalance(erc20, lootbox.address, -300);
    tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, other.address, [0], [200]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, other.address, [0], [200]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, other.address, 200)
      .to.changeTokenBalance(erc20, lootbox.address, -200);
    tx = lootbox.emergencyWithdraw(erc20extra.address, RewardType.ERC20, ZERO_ADDRESS, [0], [100]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc20extra.address, RewardType.ERC20, owner.address, [0], [100]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20extra, owner.address, 100)
      .to.changeTokenBalance(erc20extra, lootbox.address, -100);
    await expectInventory(lootbox, expectedInventory, expectedLeftovers);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
  });

  // it.skip('should allow admin to withdraw allowed ERC721 from inventory', async function () {});
  // it.skip('should allow admin to withdraw allowed ERC721 from leftovers', async function () {});
  // it.skip('should allow admin to withdraw restricted ERC721', async function () {});
  it('should allow admin to emergency withdraw ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc721extra = await deploy('MockERC721', supplier, 20);
    await lootbox.addTokens([erc721.address, erc721extra.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 3);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 2);
    await erc721extra.connect(supplier).transferFrom(supplier.address, lootbox.address, 1);
    await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    await lootbox.setAmountsPerUnit([erc721extra.address], [NOT_USED], [3]);
    let tx = lootbox.emergencyWithdraw(erc721.address, RewardType.ERC721, supplier.address, [0], [0]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc721.address, RewardType.ERC721, supplier.address, [0], [0]],
    ]);
    tx = lootbox.emergencyWithdraw(erc721.address, RewardType.ERC721, other.address, [3, 2], [0, 0]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc721.address, RewardType.ERC721, other.address, [3, 2], [0, 0]],
    ]);
    tx = lootbox.emergencyWithdraw(erc721extra.address, RewardType.ERC721, ZERO_ADDRESS, [1, 5], [0, 0]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc721extra.address, RewardType.ERC721, owner.address, [1, 5], [0, 0]],
    ]);
    expect(await erc721.ownerOf(0)).to.equal(supplier.address);
    expect(await erc721.ownerOf(2)).to.equal(other.address);
    expect(await erc721.ownerOf(3)).to.equal(other.address);
    expect(await erc721extra.ownerOf(1)).to.equal(owner.address);
    expect(await erc721extra.ownerOf(5)).to.equal(owner.address);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(3);
  });

  // it.skip('should allow admin to withdraw allowed ERC1155 from inventory', async function () {});
  // it.skip('should allow admin to withdraw allowed ERC1155 from leftovers', async function () {});
  it('should allow admin to emergency withdraw ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc1155extra = await deploy('MockERC1155', supplier, 10, 1000);
    await lootbox.addTokens([erc1155.address, erc1155extra.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 3, 10, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 10, '0x');
    await erc1155extra.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 10, '0x');
    await erc1155extra.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 5, 10, '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [3]);
    let tx = lootbox.emergencyWithdraw(erc1155.address, RewardType.ERC1155, supplier.address, [0], [10]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc1155.address, RewardType.ERC1155, supplier.address, [0], [10]],
    ]);
    tx = lootbox.emergencyWithdraw(erc1155.address, RewardType.ERC1155, other.address, [3, 2], [10, 10]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc1155.address, RewardType.ERC1155, other.address, [3, 2], [10, 10]],
    ]);
    tx = lootbox.emergencyWithdraw(erc1155extra.address, RewardType.ERC1155, ZERO_ADDRESS, [1, 5], [10, 10]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc1155extra.address, RewardType.ERC1155, owner.address, [1, 5], [10, 10]],
    ]);
    expect(await erc1155.balanceOf(supplier.address, 0)).to.equal(1000);
    expect(await erc1155.balanceOf(other.address, 2)).to.equal(10);
    expect(await erc1155.balanceOf(other.address, 3)).to.equal(10);
    expect(await erc1155extra.balanceOf(owner.address, 1)).to.equal(10);
    expect(await erc1155extra.balanceOf(owner.address, 5)).to.equal(10);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 3,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 3,
        amountPerUnit: 3,
        balance: 9,
      }],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(3);
  });

  // it.skip('should allow admin to withdraw allowed ERC1155 NFT from inventory', async function () {});
  // it.skip('should allow admin to withdraw allowed ERC1155 NFT from leftovers', async function () {});
  it('should allow admin to emergency withdraw ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc1155NFTextra = await deploy('MockERC1155NFT', supplier, 20);
    await lootbox.addTokens([erc1155NFT.address, erc1155NFTextra.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 3, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await erc1155NFTextra.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 1, 1, '0x');
    await erc1155NFTextra.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 5, 1, '0x');
    await lootbox.setAmountsPerUnit([erc1155NFTextra.address], [NOT_USED], [3]);
    let tx = lootbox.emergencyWithdraw(erc1155NFT.address, RewardType.ERC1155NFT, supplier.address, [0], [1]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc1155NFT.address, RewardType.ERC1155NFT, supplier.address, [0], [1]],
    ]);
    tx = lootbox.emergencyWithdraw(erc1155NFT.address, RewardType.ERC1155NFT, other.address, [3, 2], [1, 1]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc1155NFT.address, RewardType.ERC1155NFT, other.address, [3, 2], [1, 1]],
    ]);
    tx = lootbox.emergencyWithdraw(erc1155NFTextra.address, RewardType.ERC1155NFT, ZERO_ADDRESS, [1, 5], [1, 1]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc1155NFTextra.address, RewardType.ERC1155NFT, owner.address, [1, 5], [1, 1]],
    ]);
    expect(await erc1155NFT.balanceOf(supplier.address, 0)).to.equal(1);
    expect(await erc1155NFT.balanceOf(other.address, 2)).to.equal(1);
    expect(await erc1155NFT.balanceOf(other.address, 3)).to.equal(1);
    expect(await erc1155NFTextra.balanceOf(owner.address, 1)).to.equal(1);
    expect(await erc1155NFTextra.balanceOf(owner.address, 5)).to.equal(1);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 3,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(3), NFT(2)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(3);
  });

  it('should allow admin to emergency withdraw with open requests', async function () {
    const { lootbox, erc20, link } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 11;
    const expectedUnits = 90;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: 990,
      extra: [],
    }];
    const expectedLeftovers = [];
    await lootbox.mintBatch(user.address, [1], [5], '0x');
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
    let tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, supplier.address, [0], [300]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, supplier.address, [0], [300]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, supplier.address, 300)
      .to.changeTokenBalance(erc20, lootbox.address, -300);
    tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, user.address, [0], [200]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, user.address, [0], [200]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, user.address, 200)
      .to.changeTokenBalance(erc20, lootbox.address, -200);
    expect(await lootbox.unitsSupply()).to.equal(expectedUnits);
    expect(await lootbox.unitsRequested()).to.equal(2);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should allow admin to emergency withdraw with allocated rewards', async function () {
    const { lootbox, erc20, vrfCoordinator, link, vrfWrapper } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    const totalAmount = 1000;
    const amountPerUnit = 11;
    const expectedUnits = 88;
    const expectedInventory = [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: expectedUnits,
      amountPerUnit: amountPerUnit,
      balance: 968,
      extra: [],
    }];
    const expectedLeftovers = [];
    await lootbox.mintBatch(user.address, [1], [5], '0x');
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    let tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, supplier.address, [0], [300]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyModeEnabled', owner.address],
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, supplier.address, [0], [300]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, supplier.address, 300)
      .to.changeTokenBalance(erc20, lootbox.address, -300);
    tx = lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, user.address, [0], [700]);
    await expectContractEvents(tx, lootbox, [
      ['EmergencyWithdrawal', erc20.address, RewardType.ERC20, user.address, [0], [700]],
    ]);
    await expect(tx)
      .to.changeTokenBalance(erc20, user.address, 700)
      .to.changeTokenBalance(erc20, lootbox.address, -700);
    expect(await lootbox.unitsSupply()).to.equal(88);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });

  // it.skip('should restrict others to withdraw assets', async function () {});
  it('should restrict others to emergency withdraw assets', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const totalAmount = 1000;
    const amountPerUnit = 11;
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await erc20extra.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    await expect(lootbox.connect(supplier).emergencyWithdraw(erc20.address, RewardType.ERC20, owner.address, [0], [300]))
      .to.be.revertedWith(/AccessControl/);
    await expect(lootbox.connect(other).emergencyWithdraw(erc20extra.address, RewardType.ERC20, other.address, [0], [300]))
      .to.be.revertedWith(/AccessControl/);
  });
  it('should restrict emergency withdraw with different input arrays length', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const totalAmount = 1000;
    const amountPerUnit = 11;
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await erc20extra.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    await expect(lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, owner.address, [], [300]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.emergencyWithdraw(erc20extra.address, RewardType.ERC20, other.address, [0], []))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
  });
  it('should restrict emergency withdraw invalid token type', async function () {
    const { lootbox, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const totalAmount = 1000;
    const amountPerUnit = 11;
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, totalAmount);
    await erc20extra.connect(supplier).transfer(lootbox.address, totalAmount);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [amountPerUnit]);
    await expect(lootbox.emergencyWithdraw(erc20.address, RewardType.UNSET, owner.address, [0], [300]))
      .to.be.revertedWithCustomError(lootbox, 'UnexpectedRewardType')
      .withArgs(RewardType.UNSET);
    await expect(lootbox.emergencyWithdraw(erc20extra.address, RewardType.UNSET, other.address, [0], [300]))
      .to.be.revertedWithCustomError(lootbox, 'UnexpectedRewardType')
      .withArgs(RewardType.UNSET);
  });
  it('should restrict lootbox functions when emergency mode is on', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 2);
    await lootbox.emergencyWithdraw(erc20.address, RewardType.ERC20, owner.address, [0], [10]);
    await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price}))
      .to.be.revertedWithCustomError(lootbox, 'EndOfService');
    await expect(erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0))
      .to.be.revertedWithCustomError(lootbox, 'EndOfService');
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    )).to.be.revertedWithCustomError(lootbox, 'EndOfService');
  });

  it('should take into account requested units when setting amounts per unit', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [12]);
      await expect(lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [13]))
        .to.be.revertedWithCustomError(lootbox, 'InsufficientSupply')
        .withArgs(7, 8);
    });
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
  it('should take into account allocated rewards when setting amounts per unit for ERC20', async function () {
    const { lootbox, erc20, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    const tx = lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [20]);
    await expectContractEvents(tx, lootbox, [
      ['AmountPerUnitSet', erc20.address, 0, 20, 3],
    ]);
    await expectInventory(lootbox, [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: 3,
      amountPerUnit: 20,
      balance: 60,
      extra: [],
    }], [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: 20,
      balance: 10,
      extra: [],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(3);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(3);
  });
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
  it('should take into account allocated rewards when setting amounts per unit for ERC721', async function () {
    const { lootbox, erc721, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 10);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 19);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    const tx = lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [2]);
    await expectContractEvents(tx, lootbox, [
      ['AmountPerUnitSet', erc721.address, NOT_USED, 2, 1],
    ]);
    await expectInventory(lootbox, [{
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(19), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(1);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(1);
  });
  it('should show remainder amount of tokens for ERC721', async function () {
    const { lootbox, erc721 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 2);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    await lootbox.setAmountsPerUnit([erc721.address], [NOT_USED], [2]);
    const amountPerUnit = 4;
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
  it('should take into account allocated rewards when setting amounts per unit for ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 10, 13], [1, 1, 1, 1], '0x');
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    const tx = lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [2]);
    await expectContractEvents(tx, lootbox, [
      ['AmountPerUnitSet', erc1155NFT.address, NOT_USED, 2, 1],
    ]);
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(13), NFT(5)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(1);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(1);
  });
  it('should show remainder amount of tokens for ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 2, 1, '0x');
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 5, 1, '0x');
    await lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [2]);
    const amountPerUnit = 4;
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
  it('should take into account allocated rewards when setting amounts per unit for ERC1155 per ID', async function () {
    const { lootbox, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 8, 9], [10, 40, 30, 40], '0x');
    await lootbox.setAmountsPerUnit(
      [erc1155.address, erc1155.address, erc1155.address, erc1155.address],
      [0, 5, 8, 9], [10, 20, 15, 8]);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    const tx = lootbox.setAmountsPerUnit(
      [erc1155.address, erc1155.address],
      [0, 9], [5, 4]
    );
    await expectContractEvents(tx, lootbox, [
      ['AmountPerUnitSet', erc1155.address, 0, 5, 3],
      ['AmountPerUnitSet', erc1155.address, 9, 4, 4],
    ]);
    await expectInventory(lootbox, [{
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 4,
      amountPerUnit: NOT_USED,
      balance: NOT_USED,
      extra: [{
        id: 0,
        units: 2,
        amountPerUnit: 5,
        balance: 10,
      }, {
        id: 9,
        units: 2,
        amountPerUnit: 4,
        balance: 8,
      }],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(4);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(4);
  });
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC721]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC721]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC721]);
  });

  it('should allow supplier to supply single allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 1, '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
  });
  it('should restrict supplier to supply single ERC1155 NFT if it was already assigned a different type', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155NFT.address, ethers.utils.parseUnits('100'));
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
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
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [1, 1], '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
  });
  it('should restrict others to supply multiple allowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, other.address, [1, 2], [1, 1], '0x');
    await expect(erc1155NFT.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await expect(erc1155NFT.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [2], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple disalowed ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply multiple ERC1155 NFT', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1, 2], [1, 1], '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
  });
  it('should restrict supplier to supply multiple ERC1155 NFT if it was already assigned a different type', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155NFT.address, ethers.utils.parseUnits('100'));
    const erc1155NFTSigner = await ethers.getImpersonatedSigner(erc1155NFT.address);
    await lootbox.connect(erc1155NFTSigner).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied multiple ERC1155 NFT straight into inventory with 1 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [1, 1], '0x');
    await expectInventory(lootbox, [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 2,
      amountPerUnit: 1,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }], []);
    expect(await lootbox.unitsSupply()).to.equal(2);
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
  });
  it('should put resupplied multiple ERC1155 NFT into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await lootbox.setAmountsPerUnit([erc1155NFT.address], [NOT_USED], [0]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1, 2], [1, 1], '0x');
    await expectInventory(lootbox, [], [{
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 0,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1), NFT(2)],
    }]);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155NFT]);
  });
  it('should restrict supplier to resupply multiple ERC1155 NFT if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple ERC1155 NFT with value > 1', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [2], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2], [2], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple ERC1155 NFT with zero value', async function () {
    const { lootbox, erc1155NFT } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x');
    await expect(erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x');
  });

  it('should allow supplier to supply single allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 5, '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should restrict supplier to supply single ERC1155 if it was already assigned a different type', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155.address, ethers.utils.parseUnits('100'));
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should allow supplier to resupply single ERC1155 if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 2, '0x');
    await erc1155.connect(supplier).safeTransferFrom(supplier.address, lootbox.address, 0, 10, '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
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
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [5, 8], '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should restrict others to supply multiple allowed ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier, other] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, other.address, [0, 1], [10, 5], '0x');
    await expect(erc1155.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [0], [10], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [1], [2], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [10], '0x');
    await expect(erc1155.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [0], [10], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(other).safeBatchTransferFrom(other.address, lootbox.address, [1], [5], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should restrict supplier to supply multiple disalowed ERC1155', async function () {
    const { lootbox, erc1155, erc20 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [10], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [20], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should allow supplier to resupply multiple ERC1155', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1, 2], [11, 13, 33], '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [11, 13]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1, 2], [11, 13, 33], '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should restrict supplier to supply multiple ERC1155 if it was already assigned a different type', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await setBalance(erc1155.address, ethers.utils.parseUnits('100'));
    const erc1155Signer = await ethers.getImpersonatedSigner(erc1155.address);
    await lootbox.connect(erc1155Signer).onERC721Received(ZERO_ADDRESS, supplier.address, 0, '0x'); // This should mark it as ERC721.
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });
  it('should put first time supplied multiple ERC1155 into leftovers with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [11, 13], '0x');
    await lootbox.setAmountsPerUnit([erc1155.address], [0], [11]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2], [33], '0x');
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should put resupplied multiple ERC1155 into leftovers if configured with 0 reward per unit', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [11, 13], '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [0, 0]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [8, 10], '0x');
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should put resupplied multiple ERC1155 into leftovers if there is a remainder', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [11, 13], '0x');
    await lootbox.setAmountsPerUnit([erc1155.address, erc1155.address], [0, 1], [10, 12]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1], [8, 10], '0x');
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
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should allow supplier to resupply multiple ERC1155 if this ID was already supplied', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [2], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 1, 1], [10, 10, 20], '0x');
    expect(await lootbox.getAllowedTokenTypes()).to.eql([RewardType.ERC1155]);
  });
  it('should restrict supplier to supply multiple ERC1155 with zero value', async function () {
    const { lootbox, erc1155 } = await loadFixture(deployLootbox);
    const [owner, supplier] = await ethers.getSigners();
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [2], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [1], '0x');
    await expect(erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [1], [0], '0x'))
      .to.be.revertedWith(/ERC1155Receiver/);
  });

  it('should allow minter to mint lootboxes', async function () {
    const { lootbox, MINTER } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await lootbox.mint(user.address, 1, 10, '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(10);
    expect(await lootbox.unitsMinted()).to.equal(10);
    await lootbox.mintBatch(user.address, [2], [4], '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(10);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(4);
    expect(await lootbox.unitsMinted()).to.equal(18);
    await lootbox.grantRole(MINTER, other.address);
    await lootbox.connect(other).mintBatch(user.address, [3, 1], [4, 2], '0x');
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(12);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(4);
    expect(await lootbox.balanceOf(user.address, 3)).to.equal(4);
    expect(await lootbox.unitsMinted()).to.equal(32);
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

  it('should allow minter to mint lootboxes to many receivers', async function () {
    const { lootbox, MINTER } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await lootbox.mintToMany([user.address, other.address], [1, 3], [10, 4]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(10);
    expect(await lootbox.balanceOf(user.address, 3)).to.equal(0);
    expect(await lootbox.balanceOf(other.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(other.address, 3)).to.equal(4);
    expect(await lootbox.unitsMinted()).to.equal(22);
    await lootbox.grantRole(MINTER, other.address);
    await lootbox.connect(other).mintToMany([user.address, other.address], [1, 3], [10, 4]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(20);
    expect(await lootbox.balanceOf(user.address, 3)).to.equal(0);
    expect(await lootbox.balanceOf(other.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(other.address, 3)).to.equal(8);
    expect(await lootbox.unitsMinted()).to.equal(44);
  });
  it('should restrict others to mint lootboxes to many receivers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.connect(other).mintToMany([user.address, other.address], [1, 3], [10, 4]))
      .to.be.revertedWith(/role/);
  });
  it('should restrict minting of 0 id lootboxes to many receivers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.mintToMany([user.address], [0], [1]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mintToMany([user.address], [0], [10]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
  });
  it('should restrict minting of 256+ id lootboxes to many receivers', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.mintToMany([user.address], [256], [1]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mintToMany([user.address], [256], [10]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
    await expect(lootbox.mintToMany([user.address], [1000], [1]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLootboxType');
  });
  it('should restrict to mint lootboxes to many receivers with different input arrays length', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [minter, other, user] = await ethers.getSigners();
    await expect(lootbox.mintToMany([user.address], [1, 2], [10]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.mintToMany([user.address], [1, 2], [10, 11]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.mintToMany([user.address], [1], [10, 11]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.mintToMany([user.address, other.address], [1, 2], [10]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.mintToMany([user.address, other.address], [1], [10]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
    await expect(lootbox.mintToMany([user.address, other.address], [1], [10, 11]))
      .to.be.revertedWithCustomError(lootbox, 'InvalidLength');
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

  it('should calculate open price based on the gas, VRF and LINK price and fee per unit', async function () {
    const { lootbox, ethLinkPrice, vrfPrice1M, factory } = await loadFixture(deployLootbox);
    const expectedVRFPrice = vrfPrice1M.mul(ethLinkPrice).div(LINK_UNIT);
    expect(await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 0)).to.equal(expectedVRFPrice);
    expect(await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 10)).to.equal(expectedVRFPrice);
    await factory.setFeePerUnit(lootbox.address, 1000);
    expect(await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 0)).to.equal(expectedVRFPrice);
    expect(await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 10)).to.equal(expectedVRFPrice.add('10000'));
  });

  it('should recover lootboxes from an own failed open request', async function () {
    const { lootbox, erc20, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [20, 40], '0x');
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [0], [2]);
    const notEnoughGas = 100000;
    const price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [10, 15], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, '0x');
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
    await expectRequest(lootbox, user.address, user.address, 0, [1, 2], [10, 15]);
    const tx = lootbox.connect(user).recoverBoxes(user.address);
    await expectContractEvents(tx, lootbox, [
      ['TransferBatch', user.address, ZERO_ADDRESS, user.address, [1, 2], [10, 15]],
      ['BoxesRecovered', user.address, requestId],
    ]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(20);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(40);
    expect(await lootbox.unitsSupply()).to.equal(50);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(50);
  });
  it('should recover lootboxes from another opener failed request', async function () {
    const { lootbox, erc20, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [20, 40], '0x');
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [0], [2]);
    const notEnoughGas = 100000;
    const price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [10, 15], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, '0x');
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
    const tx = lootbox.connect(supplier).recoverBoxes(user.address);
    await expectContractEvents(tx, lootbox, [
      ['TransferBatch', supplier.address, ZERO_ADDRESS, user.address, [1, 2], [10, 15]],
      ['BoxesRecovered', user.address, requestId],
    ]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(20);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(40);
    expect(await lootbox.unitsSupply()).to.equal(50);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(50);
  });
  it('should not recover lootboxes if there is no request for an opener', async function () {
    const { lootbox, erc20, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [20, 40], '0x');
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [0], [2]);
    const notEnoughGas = 100000;
    const price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [10, 15], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, '0x');
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
    const tx = lootbox.connect(user).recoverBoxes(supplier.address);
    await expect(tx).to.be.revertedWithCustomError(lootbox, 'NothingToRecover');
  });
  it('should not recover lootboxes if the request is not failed for an opener', async function () {
    const { lootbox, erc20, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [20, 40], '0x');
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [0], [2]);
    const notEnoughGas = 100000;
    const price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [10, 15], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    const tx = lootbox.connect(user).recoverBoxes(user.address);
    await expect(tx).to.be.revertedWithCustomError(lootbox, 'PendingOpenRequest')
      .withArgs(requestId);
  });
  it('should not recover lootboxes after a successful recovery', async function () {
    const { lootbox, erc20, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [20, 40], '0x');
    await lootbox.addTokens([erc20.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await lootbox.setAmountsPerUnit([erc20.address], [0], [2]);
    const notEnoughGas = 100000;
    const price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [10, 15], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, '0x');
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
    await lootbox.connect(supplier).recoverBoxes(user.address);
    const tx = lootbox.connect(supplier).recoverBoxes(user.address);
    await expect(tx).to.be.revertedWithCustomError(lootbox, 'NothingToRecover');
  });

  it('should claim own allocated rewards', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const erc721extra = await deploy('MockERC721', supplier, 20);
    const erc1155extra = await deploy('MockERC1155', supplier, 10, 1000);
    const erc1155NFTextra = await deploy('MockERC1155NFT', supplier, 15);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addTokens([erc20extra.address, erc721extra.address, erc1155NFTextra.address, erc1155extra.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await erc20extra.connect(supplier).transfer(lootbox.address, 100);
    await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFTextra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155extra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    await lootbox.setAmountsPerUnit(
      [erc20extra.address, erc721extra.address, erc1155NFTextra.address],
      [0, 0, 0], [0, 0, 0]
    );
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    let tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc20.address, 0, 25],
      ['RewardsClaimed', user.address, erc1155.address, 5, 25],
      ['RewardsClaimed', user.address, erc1155.address, 4, 15],
    ]);
    expect(await erc20.balanceOf(user.address)).to.equal(25);
    expect(await erc1155.balanceOf(user.address, 5)).to.equal(25);
    expect(await erc1155.balanceOf(user.address, 4)).to.equal(15);
    await expectInventory(lootbox, [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: 3,
      amountPerUnit: 25,
      balance: 75,
      extra: [],
    }, {
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 2,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: 1,
        amountPerUnit: 15,
        balance: 15,
      }, {
        id: 5,
        units: 1,
        amountPerUnit: 25,
        balance: 25,
      }],
    }], [{
      rewardToken: erc20extra.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: 100,
      extra: [],
    }, {
      rewardToken: erc721extra.address,
      rewardType: RewardType.ERC721,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFTextra.address,
      rewardType: RewardType.ERC1155NFT,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155extra.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 30,
      }, {
        id: 5,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 50,
      }],
    }]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(3);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
    expect(await lootbox.unitsSupply()).to.equal(7);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(7);
    price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 7);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [3, 2], {value: price});
    requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
    tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc20.address, 0, 75],
      ['RewardsClaimed', user.address, erc721.address, 0, 1],
      ['RewardsClaimed', user.address, erc721.address, 1, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 2, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 3, 1],
      ['RewardsClaimed', user.address, erc1155.address, 4, 15],
      ['RewardsClaimed', user.address, erc1155.address, 5, 25],
    ]);
    expect(await erc20.balanceOf(user.address)).to.equal(100);
    expect(await erc1155.balanceOf(user.address, 5)).to.equal(50);
    expect(await erc1155.balanceOf(user.address, 4)).to.equal(30);
    expect(await erc1155NFT.balanceOf(user.address, 3)).to.equal(1);
    expect(await erc1155NFT.balanceOf(user.address, 2)).to.equal(1);
    expect(await erc721.ownerOf(0)).to.equal(user.address);
    expect(await erc721.ownerOf(1)).to.equal(user.address);
    await expectInventory(lootbox, [], [{
      rewardToken: erc20extra.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: 100,
      extra: [],
    }, {
      rewardToken: erc721extra.address,
      rewardType: RewardType.ERC721,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFTextra.address,
      rewardType: RewardType.ERC1155NFT,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155extra.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 30,
      }, {
        id: 5,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 50,
      }],
    }]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should claim another opener allocated rewards', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    const erc20extra = await deploy('MockERC20', supplier, 100000);
    const erc721extra = await deploy('MockERC721', supplier, 20);
    const erc1155extra = await deploy('MockERC1155', supplier, 10, 1000);
    const erc1155NFTextra = await deploy('MockERC1155NFT', supplier, 15);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addTokens([erc20extra.address, erc721extra.address, erc1155NFTextra.address, erc1155extra.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await erc20extra.connect(supplier).transfer(lootbox.address, 100);
    await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFTextra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155extra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    await lootbox.setAmountsPerUnit(
      [erc20extra.address, erc721extra.address, erc1155NFTextra.address],
      [0, 0, 0], [0, 0, 0]
    );
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    let tx = lootbox.connect(supplier).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc20.address, 0, 25],
      ['RewardsClaimed', user.address, erc1155.address, 5, 25],
      ['RewardsClaimed', user.address, erc1155.address, 4, 15],
    ]);
    expect(await erc20.balanceOf(user.address)).to.equal(25);
    expect(await erc1155.balanceOf(user.address, 5)).to.equal(25);
    expect(await erc1155.balanceOf(user.address, 4)).to.equal(15);
    await expectInventory(lootbox, [{
      rewardToken: erc20.address,
      rewardType: RewardType.ERC20,
      units: 3,
      amountPerUnit: 25,
      balance: 75,
      extra: [],
    }, {
      rewardToken: erc721.address,
      rewardType: RewardType.ERC721,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFT.address,
      rewardType: RewardType.ERC1155NFT,
      units: 1,
      amountPerUnit: 2,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155.address,
      rewardType: RewardType.ERC1155,
      units: 2,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: 1,
        amountPerUnit: 15,
        balance: 15,
      }, {
        id: 5,
        units: 1,
        amountPerUnit: 25,
        balance: 25,
      }],
    }], [{
      rewardToken: erc20extra.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: 100,
      extra: [],
    }, {
      rewardToken: erc721extra.address,
      rewardType: RewardType.ERC721,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFTextra.address,
      rewardType: RewardType.ERC1155NFT,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155extra.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 30,
      }, {
        id: 5,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 50,
      }],
    }]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(3);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
    expect(await lootbox.unitsSupply()).to.equal(7);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(7);
    price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 7);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [3, 2], {value: price});
    requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
    tx = lootbox.connect(supplier).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc20.address, 0, 75],
      ['RewardsClaimed', user.address, erc721.address, 0, 1],
      ['RewardsClaimed', user.address, erc721.address, 1, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 2, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 3, 1],
      ['RewardsClaimed', user.address, erc1155.address, 4, 15],
      ['RewardsClaimed', user.address, erc1155.address, 5, 25],
    ]);
    expect(await erc20.balanceOf(user.address)).to.equal(100);
    expect(await erc1155.balanceOf(user.address, 5)).to.equal(50);
    expect(await erc1155.balanceOf(user.address, 4)).to.equal(30);
    expect(await erc1155NFT.balanceOf(user.address, 3)).to.equal(1);
    expect(await erc1155NFT.balanceOf(user.address, 2)).to.equal(1);
    expect(await erc721.ownerOf(0)).to.equal(user.address);
    expect(await erc721.ownerOf(1)).to.equal(user.address);
    await expectInventory(lootbox, [], [{
      rewardToken: erc20extra.address,
      rewardType: RewardType.ERC20,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: 100,
      extra: [],
    }, {
      rewardToken: erc721extra.address,
      rewardType: RewardType.ERC721,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(0), NFT(1)],
    }, {
      rewardToken: erc1155NFTextra.address,
      rewardType: RewardType.ERC1155NFT,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [NFT(2), NFT(3)],
    }, {
      rewardToken: erc1155extra.address,
      rewardType: RewardType.ERC1155,
      units: NOT_USED,
      amountPerUnit: 0,
      balance: NOT_USED,
      extra: [{
        id: 4,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 30,
      }, {
        id: 5,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 50,
      }],
    }]);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should restrict claiming if paused', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 10);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [4, 3], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    await lootbox.pause();
    await expect(lootbox.connect(user).claimRewards(user.address))
      .to.be.revertedWith(/Pausable/);
  });
  it('should claim for another opener allocated ERC20 rewards', async function () {
    const { lootbox, erc20, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
    const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [4, 3], {value: price});
    const requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    const tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc20.address, 0, 100],
    ]);
    expect(await erc20.balanceOf(user.address)).to.equal(100);
    await expectInventory(lootbox, [], []);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should claim for another opener allocated ERC721 rewards', async function () {
    const { lootbox, erc721, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc721.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 10);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 19);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
    requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
    const tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc721.address, 5, 1],
      ['RewardsClaimed', user.address, erc721.address, 19, 1],
      ['RewardsClaimed', user.address, erc721.address, 10, 1],
      ['RewardsClaimed', user.address, erc721.address, 0, 1],
    ]);
    await expectInventory(lootbox, [], []);
    expect(await erc721.ownerOf(0)).to.equal(user.address);
    expect(await erc721.ownerOf(5)).to.equal(user.address);
    expect(await erc721.ownerOf(10)).to.equal(user.address);
    expect(await erc721.ownerOf(19)).to.equal(user.address);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should claim for another opener allocated ERC1155 NFT rewards', async function () {
    const { lootbox, erc1155NFT, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc1155NFT.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 10, 13], [1, 1, 1, 1], '0x');
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
    requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
    const tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc1155NFT.address, 5, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 13, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 10, 1],
      ['RewardsClaimed', user.address, erc1155NFT.address, 0, 1],
    ]);
    expect(await erc1155NFT.balanceOf(user.address, 0)).to.equal(1);
    expect(await erc1155NFT.balanceOf(user.address, 5)).to.equal(1);
    expect(await erc1155NFT.balanceOf(user.address, 10)).to.equal(1);
    expect(await erc1155NFT.balanceOf(user.address, 13)).to.equal(1);
    await expectInventory(lootbox, [], []);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });
  it('should claim for another opener allocated ERC1155 rewards', async function () {
    const { lootbox, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 8, 9], [10, 40, 30, 40], '0x');
    await lootbox.setAmountsPerUnit(
      [erc1155.address, erc1155.address, erc1155.address, erc1155.address],
      [0, 5, 8, 9], [10, 20, 15, 8]);
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
    price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
    requestId = await lootbox.openerRequests(user.address);
    await vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
    const tx = lootbox.connect(user).claimRewards(user.address);
    await expectContractEvents(tx, lootbox, [
      ['RewardsClaimed', user.address, erc1155.address, 0, 10],
      ['RewardsClaimed', user.address, erc1155.address, 9, 40],
      ['RewardsClaimed', user.address, erc1155.address, 8, 30],
      ['RewardsClaimed', user.address, erc1155.address, 5, 40],
    ]);
    expect(await erc1155.balanceOf(user.address, 0)).to.equal(10);
    expect(await erc1155.balanceOf(user.address, 5)).to.equal(40);
    expect(await erc1155.balanceOf(user.address, 8)).to.equal(30);
    expect(await erc1155.balanceOf(user.address, 9)).to.equal(40);
    await expectInventory(lootbox, [], []);
    expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
    expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
    expect(await lootbox.unitsSupply()).to.equal(0);
    expect(await lootbox.unitsRequested()).to.equal(0);
    expect(await lootbox.getAvailableSupply()).to.equal(0);
  });

  it('should restrict calling allocate rewards for not the contract itself', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    const notEnoughGas = 100000;
    let price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [4, 3], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await expect(lootbox._allocateRewards(requestId, 7))
      .to.be.revertedWithCustomError(lootbox, 'OnlyThis');
  });
  it('should restrict calling raw fulfill random words for not the VRF_V2_WRAPPER', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    const notEnoughGas = 100000;
    let price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [4, 3], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await expect(lootbox.rawFulfillRandomWords(requestId, [7]))
      .to.be.revertedWith(/fulfill/);
  });
  it('should restrict rewards allocation for a failed request', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    const notEnoughGas = 100000;
    let price = await lootbox.calculateOpenPrice(notEnoughGas, network.config.gasPrice, 10);
    await lootbox.connect(user).open(notEnoughGas, [1, 2], [4, 3], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, '0x');
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
    await expect(lootbox.connect(vrfWrapperSigner).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, lootbox.interface.encodeErrorResult('InvalidRequestAllocation', [requestId]));
    expect(await lootbox.openerRequests(user.address)).to.equal(requestId);
  });
  it('should restrict rewards allocation for an absent request', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    let requestId = 10;
    await expect(lootbox.connect(vrfWrapperSigner).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, lootbox.interface.encodeErrorResult('InvalidRequestAllocation', [requestId]));
  });
  it('should restrict rewards allocation for a fulfilled request', async function () {
    const { lootbox, erc20, erc721, erc1155NFT, erc1155, link,
      vrfWrapper, vrfCoordinator, vrfWrapperSigner } = await loadFixture(deployLootbox);
    const [owner, supplier, user] = await ethers.getSigners();
    await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
    await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
    await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
    await lootbox.addSuppliers([supplier.address]);
    await erc20.connect(supplier).transfer(lootbox.address, 100);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
    await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
    await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
    await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
    await lootbox.setAmountsPerUnit(
      [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
      [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
    );
    let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
    await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 2], {value: price});
    let requestId = await lootbox.openerRequests(user.address);
    await expect(vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFulfilled');
    expect(await lootbox.openerRequests(user.address)).to.equal(0);
    await expect(lootbox.connect(vrfWrapperSigner).rawFulfillRandomWords(requestId, [7]))
      .to.emit(lootbox, 'OpenRequestFailed')
      .withArgs(requestId, lootbox.interface.encodeErrorResult('InvalidRequestAllocation', [requestId]));
  });

  it('should revert on unknown function call', async function () {
    const { lootbox } = await loadFixture(deployLootbox);
    const [owner] = await ethers.getSigners();
    await expect(owner.sendTransaction({to: lootbox.address}))
      .to.be.revertedWithCustomError(lootbox, 'ViewCallFailed');
    await expect(owner.sendTransaction({to: lootbox.address, data: '0x12345678'}))
      .to.be.revertedWithCustomError(lootbox, 'ViewCallFailed');
  });

  // describe.skip('LINK payment', function() {
  //   it.skip('should allow LINK as ERC677 transfer and call to create an open request', async function () {});
  //   it.skip('should restrict other tokens as ERC677 transfer and call', async function () {});
  //   it.skip('should restrict to create an open request with LINK payment less than VRF price', async function () {});
  //   it.skip('should restrict to create an open request with LINK payment less than VRF price plus LINK factory fee', async function () {});
  //   it.skip('should forward the open fee in LINK to the factory when creating an open request', async function () {});
  //   it.skip('should not forward a zero fee in LINK to the factory when creating an open request', async function () {});
  //   it.skip('should return the excess LINK to the opener when creating an open request', async function () {});

  //   it.skip('should restrict more then one pending open request per opener', async function () {});
  //   it.skip('should restrict open request with less than 100,000 gas for VRF request', async function () {});
  //   it.skip('should restrict open request when paused', async function () {});
  //   it.skip('should restrict open with zero total units', async function () {});
  //   it.skip('should restrict open with total units less than supply', async function () {});
  //   it.skip('should burn boxes specified in open request', async function () {});

  //   it.skip('should allocate ERC20 rewards', async function () {});
  //   it.skip('should allocate ERC721 rewards', async function () {});
  //   it.skip('should allocate ERC1155 rewards', async function () {});
  //   it.skip('should allocate ERC1155 NFT rewards', async function () {});
  //   it.skip('should allocate all rewards', async function () {});
  //   it.skip('should move remainder of ERC721 rewards to leftovers', async function () {});
  //   it.skip('should move remainder of ERC1155 NFT rewards to leftovers', async function () {});
  // });

  describe('Native currency payment', function() {
    it('should allow native currency payment to create an open request', async function () {
      const { lootbox, erc20, link, vrfPrice1M, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await expectRequest(lootbox, user.address, ZERO_ADDRESS, 0, [], []);
      const tx = lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      await tx;
      await expectRequest(lootbox, user.address, user.address, 1, [1], [1]);
      const requestId = await lootbox.openerRequests(user.address);
      await expect(tx).to.emit(lootbox, 'OpenRequested')
        .withArgs(user.address, 1, requestId);
      expect(requestId).to.not.equal(0);
      await expect(tx).to.changeEtherBalance(user.address, price.mul('-1'));
      await expect(tx).to.changeEtherBalance(factory.address, 0);
      await expect(tx).to.changeEtherBalance(lootbox.address, price);
      await expect(tx).to.changeTokenBalance(link, lootbox.address, vrfPrice1M.mul('-1'));
    });
    it('should restrict native currency deposit outside of open function', async function () {
      const { lootbox } = await loadFixture(deployLootbox);
      const [owner] = await ethers.getSigners();
      await expect(owner.sendTransaction({to: lootbox.address, value: 1}))
        .to.be.reverted;
    });
    it('should restrict to create an open request with native payment less than VRF native price', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price.sub('1')}))
        .to.be.revertedWithCustomError(lootbox, 'InsufficientPayment');
    });
    it('should restrict to create an open request with native payment less than VRF native price plus factory fee', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      await factory.setFeePerUnit(lootbox.address, 1);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price.sub('1')}))
        .to.be.revertedWithCustomError(lootbox, 'InsufficientFee');
    });
    it('should forward the native open fee to the factory when creating an open request', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      await factory.setFeePerUnit(lootbox.address, 1);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      const tx = lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      await expect(tx).to.changeEtherBalance(user.address, price.mul('-1'));
      await expect(tx).to.changeEtherBalance(factory.address, 1);
      await expect(tx).to.changeEtherBalance(lootbox.address, price.sub('1'));
    });
    it('should not forward a zero native fee in to the factory when creating an open request', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      const tx = lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      await expect(tx).to.not.emit(factory, 'Payment');
    });
    it('should return the excess native payment to the opener when creating an open request without factory fee', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      const tx = lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price.add('7')});
      await expect(tx).to.changeEtherBalance(user.address, price.mul('-1'));
      await expect(tx).to.changeEtherBalance(factory.address, 0);
    });
    it('should return the excess native payment to the opener when creating an open request with factory fee', async function () {
      const { lootbox, erc20, link, factory } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      await factory.setFeePerUnit(lootbox.address, 1);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      const tx = lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price.add('7')});
      await expect(tx).to.changeEtherBalance(user.address, price.mul('-1'));
      await expect(tx).to.changeEtherBalance(factory.address, 1);
    });

    it('should restrict more then one pending open request per opener', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 2, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      const requestId = await lootbox.openerRequests(user.address);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price}))
        .to.be.revertedWithCustomError(lootbox, 'PendingOpenRequest')
        .withArgs(requestId);
    });
    it('should restrict open request with less than 100,000 gas for VRF request', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await expect(lootbox.connect(user).open(99999, [1], [1], {value: price}))
        .to.be.revertedWithCustomError(lootbox, 'InsufficientGas');
    });
    it('should restrict open request when paused', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await lootbox.pause();
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price}))
        .to.be.revertedWith(/Pausable/);
    });
    it('should restrict open with zero total units', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price}))
        .to.be.revertedWithCustomError(lootbox, 'SupplyExceeded')
        .withArgs(0, 1);
    });
    it('should restrict open with total units less than supply', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 11, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 11);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [11], {value: price}))
        .to.be.revertedWithCustomError(lootbox, 'SupplyExceeded')
        .withArgs(10, 11);
    });
    it('should restrict open zero units', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 0);
      await expect(lootbox.connect(user).open(REQUEST_GAS_LIMIT, [], [], {value: price}))
        .to.be.revertedWithCustomError(lootbox, 'ZeroAmount');
    });
    it('should burn boxes specified in open request', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mint(user.address, 1, 1, '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(10);
      expect(await lootbox.unitsRequested()).to.equal(1);
      expect(await lootbox.getAvailableSupply()).to.equal(9);
    });
    it('should burn multiple boxes specified in open request', async function () {
      const { lootbox, erc20, link } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      const price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(10);
      expect(await lootbox.unitsRequested()).to.equal(8);
      expect(await lootbox.getAvailableSupply()).to.equal(2);
    });

    it('should allocate ERC20 rewards', async function () {
      const { lootbox, erc20, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc20.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.setAmountsPerUnit([erc20.address], [NOT_USED], [10]);
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 8);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [{
        rewardToken: erc20.address,
        rewardType: RewardType.ERC20,
        units: 2,
        amountPerUnit: 10,
        balance: 20,
        extra: [],
      }], []);
      expect(await lootbox.openerRequests(user.address)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(2);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(2);
      price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 2);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
      requestId = await lootbox.openerRequests(user.address);
      tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc20.address, 0, 10],
        ['Allocated', user.address, erc20.address, 0, 10],
        ['OpenRequestFulfilled', requestId, 9],
      ]);
      await expectInventory(lootbox, [], []);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
    it('should allocate ERC721 rewards', async function () {
      const { lootbox, erc721, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc721.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 10);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 19);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc721.address, 0, 1],
        ['Allocated', user.address, erc721.address, 10, 1],
        ['Allocated', user.address, erc721.address, 19, 1],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [{
        rewardToken: erc721.address,
        rewardType: RewardType.ERC721,
        units: 1,
        amountPerUnit: 1,
        balance: NOT_USED,
        extra: [NFT(5)],
      }], []);
      expect(await lootbox.openerRequests(user.address)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(3);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
      expect(await lootbox.unitsSupply()).to.equal(1);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(1);
      price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      requestId = await lootbox.openerRequests(user.address);
      tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc721.address, 5, 1],
        ['OpenRequestFulfilled', requestId, 9],
      ]);
      await expectInventory(lootbox, [], []);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
    it('should allocate ERC1155 rewards', async function () {
      const { lootbox, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc1155.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 8, 9], [10, 40, 30, 40], '0x');
      await lootbox.setAmountsPerUnit(
        [erc1155.address, erc1155.address, erc1155.address, erc1155.address],
        [0, 5, 8, 9], [10, 20, 15, 8]);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [2, 3], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155.address, 5, 20],
        ['Allocated', user.address, erc1155.address, 8, 15],
        ['Allocated', user.address, erc1155.address, 9, 8],
        ['Allocated', user.address, erc1155.address, 9, 8],
        ['Allocated', user.address, erc1155.address, 5, 20],
        ['Allocated', user.address, erc1155.address, 9, 8],
        ['Allocated', user.address, erc1155.address, 9, 8],
        ['Allocated', user.address, erc1155.address, 8, 15],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
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
          id: 9,
          units: 1,
          amountPerUnit: 8,
          balance: 8,
        }],
      }], []);
      expect(await lootbox.openerRequests(user.address)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(2);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(2);
      price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 2);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [2], {value: price});
      requestId = await lootbox.openerRequests(user.address);
      tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155.address, 9, 8],
        ['Allocated', user.address, erc1155.address, 0, 10],
        ['OpenRequestFulfilled', requestId, 9],
      ]);
      await expectInventory(lootbox, [], []);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
    it('should allocate ERC1155 NFT rewards', async function () {
      const { lootbox, erc1155NFT, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc1155NFT.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 10, 13], [1, 1, 1, 1], '0x');
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155NFT.address, 0, 1],
        ['Allocated', user.address, erc1155NFT.address, 10, 1],
        ['Allocated', user.address, erc1155NFT.address, 13, 1],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [{
        rewardToken: erc1155NFT.address,
        rewardType: RewardType.ERC1155NFT,
        units: 1,
        amountPerUnit: 1,
        balance: NOT_USED,
        extra: [NFT(5)],
      }], []);
      expect(await lootbox.openerRequests(user.address)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(3);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
      expect(await lootbox.unitsSupply()).to.equal(1);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(1);
      price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 1);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      requestId = await lootbox.openerRequests(user.address);
      tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155NFT.address, 5, 1],
        ['OpenRequestFulfilled', requestId, 9],
      ]);
      await expectInventory(lootbox, [], []);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(2);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
    it('should allocate all rewards', async function () {
      const { lootbox, erc20, erc721, erc1155NFT, erc1155, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      const erc20extra = await deploy('MockERC20', supplier, 100000);
      const erc721extra = await deploy('MockERC721', supplier, 20);
      const erc1155extra = await deploy('MockERC1155', supplier, 10, 1000);
      const erc1155NFTextra = await deploy('MockERC1155NFT', supplier, 15);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      await lootbox.mintBatch(user.address, [1, 2], [4, 3], '0x');
      await lootbox.addTokens([erc20.address, erc721.address, erc1155NFT.address, erc1155.address]);
      await lootbox.addTokens([erc20extra.address, erc721extra.address, erc1155NFTextra.address, erc1155extra.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc20.connect(supplier).transfer(lootbox.address, 100);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
      await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
      await erc1155.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
      await erc20extra.connect(supplier).transfer(lootbox.address, 100);
      await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
      await erc721extra.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 1);
      await erc1155NFTextra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [2, 3], [1, 1], '0x');
      await erc1155extra.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [4, 5], [30, 50], '0x');
      await lootbox.setAmountsPerUnit(
        [erc20.address, erc721.address, erc1155NFT.address, erc1155.address, erc1155.address],
        [0, 0, 0, 4, 5], [25, 2, 2, 15, 25]
      );
      await lootbox.setAmountsPerUnit(
        [erc20extra.address, erc721extra.address, erc1155NFTextra.address],
        [0, 0, 0], [0, 0, 0]
      );
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [1, 1], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155.address, 4, 15],
        ['Allocated', user.address, erc1155.address, 5, 25],
        ['Allocated', user.address, erc20.address, 0, 25],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [{
        rewardToken: erc20.address,
        rewardType: RewardType.ERC20,
        units: 3,
        amountPerUnit: 25,
        balance: 75,
        extra: [],
      }, {
        rewardToken: erc721.address,
        rewardType: RewardType.ERC721,
        units: 1,
        amountPerUnit: 2,
        balance: NOT_USED,
        extra: [NFT(0), NFT(1)],
      }, {
        rewardToken: erc1155NFT.address,
        rewardType: RewardType.ERC1155NFT,
        units: 1,
        amountPerUnit: 2,
        balance: NOT_USED,
        extra: [NFT(2), NFT(3)],
      }, {
        rewardToken: erc1155.address,
        rewardType: RewardType.ERC1155,
        units: 2,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [{
          id: 4,
          units: 1,
          amountPerUnit: 15,
          balance: 15,
        }, {
          id: 5,
          units: 1,
          amountPerUnit: 25,
          balance: 25,
        }],
      }], [{
        rewardToken: erc20extra.address,
        rewardType: RewardType.ERC20,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 100,
        extra: [],
      }, {
        rewardToken: erc721extra.address,
        rewardType: RewardType.ERC721,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [NFT(0), NFT(1)],
      }, {
        rewardToken: erc1155NFTextra.address,
        rewardType: RewardType.ERC1155NFT,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [NFT(2), NFT(3)],
      }, {
        rewardToken: erc1155extra.address,
        rewardType: RewardType.ERC1155,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [{
          id: 4,
          units: NOT_USED,
          amountPerUnit: 0,
          balance: 30,
        }, {
          id: 5,
          units: NOT_USED,
          amountPerUnit: 0,
          balance: 50,
        }],
      }]);
      expect(await lootbox.openerRequests(user.address)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(3);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(2);
      expect(await lootbox.unitsSupply()).to.equal(7);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(7);
      expect(await lootbox.getAllowedTokenTypes()).to.eql([
        RewardType.ERC20, RewardType.ERC721, RewardType.ERC1155NFT, RewardType.ERC1155,
        RewardType.ERC20, RewardType.ERC721, RewardType.ERC1155NFT, RewardType.ERC1155,
      ]);
      price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 7);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1, 2], [3, 2], {value: price});
      requestId = await lootbox.openerRequests(user.address);
      tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [9]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155NFT.address, 3, 1],
        ['Allocated', user.address, erc1155NFT.address, 2, 1],
        ['Allocated', user.address, erc1155.address, 5, 25],
        ['Allocated', user.address, erc1155.address, 4, 15],
        ['Allocated', user.address, erc20.address, 0, 25],
        ['Allocated', user.address, erc721.address, 1, 1],
        ['Allocated', user.address, erc721.address, 0, 1],
        ['Allocated', user.address, erc20.address, 0, 25],
        ['Allocated', user.address, erc20.address, 0, 25],
        ['OpenRequestFulfilled', requestId, 9],
      ]);
      await expectInventory(lootbox, [], [{
        rewardToken: erc20extra.address,
        rewardType: RewardType.ERC20,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: 100,
        extra: [],
      }, {
        rewardToken: erc721extra.address,
        rewardType: RewardType.ERC721,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [NFT(0), NFT(1)],
      }, {
        rewardToken: erc1155NFTextra.address,
        rewardType: RewardType.ERC1155NFT,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [NFT(2), NFT(3)],
      }, {
        rewardToken: erc1155extra.address,
        rewardType: RewardType.ERC1155,
        units: NOT_USED,
        amountPerUnit: 0,
        balance: NOT_USED,
        extra: [{
          id: 4,
          units: NOT_USED,
          amountPerUnit: 0,
          balance: 30,
        }, {
          id: 5,
          units: NOT_USED,
          amountPerUnit: 0,
          balance: 50,
        }],
      }]);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(0);
      expect(await lootbox.balanceOf(user.address, 2)).to.equal(0);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
      expect(await lootbox.getAllowedTokenTypes()).to.eql([
        RewardType.ERC20, RewardType.ERC721, RewardType.ERC1155NFT, RewardType.ERC1155,
        RewardType.ERC20, RewardType.ERC721, RewardType.ERC1155NFT, RewardType.ERC1155,
      ]);
    });
    it('should move remainder of ERC721 rewards to leftovers', async function () {
      const { lootbox, erc721, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1], [2], '0x');
      await lootbox.addTokens([erc721.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 0);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 5);
      await erc721.connect(supplier)[safeTransferFrom](supplier.address, lootbox.address, 10);
      await lootbox.setAmountsPerUnit([erc721.address], [0], [2]);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc721.address, 10, 1],
        ['Allocated', user.address, erc721.address, 5, 1],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [], [{
        rewardToken: erc721.address,
        rewardType: RewardType.ERC721,
        units: 0,
        amountPerUnit: 2,
        balance: NOT_USED,
        extra: [NFT(0)],
      }]);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(1);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
    it('should move remainder of ERC1155 NFT rewards to leftovers', async function () {
      const { lootbox, erc1155NFT, link, vrfWrapper, vrfCoordinator } = await loadFixture(deployLootbox);
      const [owner, supplier, user] = await ethers.getSigners();
      await lootbox.mintBatch(user.address, [1], [2], '0x');
      await lootbox.addTokens([erc1155NFT.address]);
      await lootbox.addSuppliers([supplier.address]);
      await erc1155NFT.connect(supplier).safeBatchTransferFrom(supplier.address, lootbox.address, [0, 5, 10], [1, 1, 1], '0x');
      await lootbox.setAmountsPerUnit([erc1155NFT.address], [0], [2]);
      await link.transfer(lootbox.address, ethers.utils.parseUnits('1000'));
      let price = await lootbox.calculateOpenPrice(REQUEST_GAS_LIMIT, network.config.gasPrice, 3);
      await lootbox.connect(user).open(REQUEST_GAS_LIMIT, [1], [1], {value: price});
      let requestId = await lootbox.openerRequests(user.address);
      let tx = vrfWrapper.connect(vrfCoordinator).rawFulfillRandomWords(requestId, [7]);
      await expectContractEvents(tx, lootbox, [
        ['Allocated', user.address, erc1155NFT.address, 10, 1],
        ['Allocated', user.address, erc1155NFT.address, 5, 1],
        ['OpenRequestFulfilled', requestId, 7],
      ]);
      await expectInventory(lootbox, [], [{
        rewardToken: erc1155NFT.address,
        rewardType: RewardType.ERC1155NFT,
        units: 0,
        amountPerUnit: 2,
        balance: NOT_USED,
        extra: [NFT(0)],
      }]);
      expect(await lootbox.balanceOf(user.address, 1)).to.equal(1);
      expect(await lootbox.unitsSupply()).to.equal(0);
      expect(await lootbox.unitsRequested()).to.equal(0);
      expect(await lootbox.getAvailableSupply()).to.equal(0);
    });
  });
});
