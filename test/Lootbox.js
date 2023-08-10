const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { expect } = require('chai');
const { linkToken, vrfV2Wrapper, linkHolder } = require('../network.config.js')['31337'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('Lootbox', function () {
  const deployLootbox = async (linkAddress, wrapperAddress) => {
    const [owner, supplier, user] = await ethers.getSigners();
    const link = await ethers.getContractAt('LinkTokenInterface', linkAddress || linkToken);
    const lootboxFactoryFactory = await ethers.getContractFactory('LootboxFactory');
    const factory = await lootboxFactoryFactory.deploy(
      link.address,
      wrapperAddress || vrfV2Wrapper
    );

    await factory.deployed();
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

    return { factory, lootbox, link, ADMIN, MINTER, PAUSER };
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

  it.skip('should allow admin to allow tokens', async function () {});
  it.skip('should not emit events when allowing duplicate tokens', async function () {});
  it.skip('should restrict others to allow tokens', async function () {});
  it.skip('should list tokens', async function () {});

  it.skip('should allow admin to withdraw native currency', async function () {});
  it.skip('should restrict others to withdraw native currency', async function () {});

  it.skip('should allow admin to set amounts per unit for ERC20', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC20 to 0', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC20', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC20 to 0', async function () {});
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC20', async function () {});
  it.skip('should show remainder amount of tokens for ERC20', async function () {});
  it.skip('should restrict admin to set amounts per unit ERC20 that was not deposited yet', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC721', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC721 to 0', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC721', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC721 to 0', async function () {});
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC721', async function () {});
  it.skip('should show remainder amount of tokens for ERC721', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC1155 NFT', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC1155 NFT to 0', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC1155 NFT', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC1155 NFT to 0', async function () {});
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC1155 NFT', async function () {});
  it.skip('should show remainder amount of tokens for ERC1155 NFT', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC1155 per ID', async function () {});
  it.skip('should allow admin to set amounts per unit for ERC1155 to 0 per ID', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC1155 per ID', async function () {});
  it.skip('should allow admin to reset amounts per unit for ERC1155 to 0 per ID', async function () {});
  it.skip('should take into account allocated rewards when setting amounts per unit for ERC1155 per ID', async function () {});
  it.skip('should show remainder amount of tokens for ERC1155 per ID', async function () {});
  it.skip('should restrict admin to set amounts per unit for a disallowed token', async function () {});

  it.skip('should allow supplier to supply allowed ERC721', async function () {});
  it.skip('should restrict others to supply allowed ERC721', async function () {});
  it.skip('should restrict supplier to supply disalowed ERC721', async function () {});
  it.skip('should allow supplier to resupply ERC721', async function () {});
  it.skip('should restrict supplier to supply ERC721 if it was already assigned a different type', async function () {});
  it.skip('should put first time supplied ERC721 straight into inventory with 1 reward per unit', async function () {});

  it.skip('should allow supplier to supply single allowed ERC1155 NFT', async function () {});
  it.skip('should restrict others to supply single allowed ERC1155 NFT', async function () {});
  it.skip('should restrict supplier to supply single disalowed ERC1155 NFT', async function () {});
  it.skip('should allow supplier to resupply single ERC1155 NFT', async function () {});
  it.skip('should restrict supplier to supply single ERC1155 NFT if it was already assigned a different type', async function () {});
  it.skip('should put first time supplied single ERC1155 NFT straight into inventory with 1 reward per unit', async function () {});
  it.skip('should put resupplied single ERC1155 NFT into leftovers if configured with 0 reward per unit', async function () {});
  it.skip('should restrict supplier to resupply single ERC1155 NFT if this ID was already supplied', async function () {});
  it.skip('should restrict supplier to supply single ERC1155 NFT with value > 1', async function () {});
  it.skip('should restrict supplier to supply single ERC1155 NFT with zero value', async function () {});

  it.skip('should allow supplier to supply multiple allowed ERC1155 NFT', async function () {});
  it.skip('should restrict others to supply multiple allowed ERC1155 NFT', async function () {});
  it.skip('should restrict supplier to supply multiple disalowed ERC1155 NFT', async function () {});
  it.skip('should allow supplier to resupply multiple ERC1155 NFT', async function () {});
  it.skip('should restrict supplier to supply multiple ERC1155 NFT if it was already assigned a different type', async function () {});
  it.skip('should put first time supplied multiple ERC1155 NFT straight into inventory with 1 reward per unit', async function () {});
  it.skip('should put resupplied multiple ERC1155 NFT into leftovers if configured with 0 reward per unit', async function () {});
  it.skip('should restrict supplier to resupply multiple ERC1155 NFT if this ID was already supplied', async function () {});
  it.skip('should restrict supplier to supply multiple ERC1155 NFT with value > 1', async function () {});
  it.skip('should restrict supplier to supply multiple ERC1155 NFT with zero value', async function () {});

  it.skip('should allow supplier to supply single allowed ERC1155', async function () {});
  it.skip('should restrict others to supply single allowed ERC1155', async function () {});
  it.skip('should restrict supplier to supply single disalowed ERC1155', async function () {});
  it.skip('should allow supplier to resupply single ERC1155', async function () {});
  it.skip('should restrict supplier to supply single ERC1155 if it was already assigned a different type', async function () {});
  it.skip('should put first time supplied single ERC1155 into leftovers with 0 reward per unit', async function () {});
  it.skip('should put resupplied single ERC1155 into leftovers if configured with 0 reward per unit', async function () {});
  it.skip('should put resupplied single ERC1155 into leftovers if there is a remainder', async function () {});
  it.skip('should allow supplier to resupply single ERC1155 if this ID was already supplied', async function () {});
  it.skip('should restrict supplier to supply single ERC1155 with zero value', async function () {});

  it.skip('should allow supplier to supply multiple allowed ERC1155', async function () {});
  it.skip('should restrict others to supply multiple allowed ERC1155', async function () {});
  it.skip('should restrict supplier to supply multiple disalowed ERC1155', async function () {});
  it.skip('should allow supplier to resupply multiple ERC1155', async function () {});
  it.skip('should restrict supplier to supply multiple ERC1155 if it was already assigned a different type', async function () {});
  it.skip('should put first time supplied multiple ERC1155 into leftovers with 0 reward per unit', async function () {});
  it.skip('should put resupplied multiple ERC1155 into leftovers if configured with 0 reward per unit', async function () {});
  it.skip('should put resupplied multiple ERC1155 into leftovers if there is a remainder', async function () {});
  it.skip('should allow supplier to resupply multiple ERC1155 if this ID was already supplied', async function () {});
  it.skip('should restrict supplier to supply multiple ERC1155 with zero value', async function () {});

  it.skip('should allow minter to mint lootboxes', async function () {});
  it.skip('should restrict others to mint lootboxes', async function () {});
  it.skip('should support IERC1155Receiver interface', async function () {});
  it.skip('should support IERC1155 interface', async function () {});
  it.skip('should list lootbox types', async function () {});

  it.skip('should calculate open price based on the gas, VRF and LINK price and fee per unit', async function () {});

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
