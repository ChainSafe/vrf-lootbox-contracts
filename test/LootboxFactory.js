const { loadFixture, setCode } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { expect } = require('chai');
const { linkToken, vrfV2Wrapper, linkHolder } = require('../network.config.js')['31337'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('LootboxFactory', function () {
  const deployFactory = async (linkAddress, wrapperAddress) => {
    const [deployer, supplier, user] = await ethers.getSigners();
    const link = await ethers.getContractAt('LinkTokenInterface', linkAddress || linkToken);
    const lootboxFactoryFactory = await ethers.getContractFactory('LootboxFactory');
    const factory = await lootboxFactoryFactory.deploy(
      link.address,
      wrapperAddress || vrfV2Wrapper
    );

    await factory.deployed();
    const impersonatedLinkHolder = await ethers.getImpersonatedSigner(linkHolder);
    await link.connect(impersonatedLinkHolder)
      .transfer(deployer.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(supplier.address, ethers.utils.parseUnits('10000'));
    await link.connect(impersonatedLinkHolder)
      .transfer(user.address, ethers.utils.parseUnits('10000'));

    return { factory, link };
  };

  it('should deploy lootbox factory and have valid defaults', async function () {
    const { factory } = await loadFixture(deployFactory);
    expect(await factory.LINK()).to.equal(linkToken);
    expect(await factory.VRFV2WRAPPER()).to.equal(vrfV2Wrapper);
    expect(await factory.feePerDeploy()).to.equal(0);
    expect(await factory.defaultFeePerUnit()).to.equal(0);
    const [someone, another] = await ethers.getSigners();
    await setCode(another.address, await ethers.provider.getCode(vrfV2Wrapper));
    const { factory: factory2 } = await deployFactory(someone.address, another.address);
    expect(await factory2.LINK()).to.equal(someone.address);
    expect(await factory2.VRFV2WRAPPER()).to.equal(another.address);
  });
  it('should allow owner to set fee per deploy', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [owner] = await ethers.getSigners();
    await expect(factory.setFeePerDeploy(100))
      .to.emit(factory, 'FeePerDeploySet')
      .withArgs(100);
    expect(await factory.feePerDeploy()).to.equal(100);
    await expect(factory.setFeePerDeploy(200))
      .to.emit(factory, 'FeePerDeploySet')
      .withArgs(200);
    expect(await factory.feePerDeploy()).to.equal(200);
    await expect(factory.setFeePerDeploy(0))
      .to.emit(factory, 'FeePerDeploySet')
      .withArgs(0);
    expect(await factory.feePerDeploy()).to.equal(0);
  });
  it('should restrict others to set fee per deploy', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [_, other] = await ethers.getSigners();
    await expect(factory.connect(other).setFeePerDeploy(100))
      .to.be.revertedWith(/Ownable/);
  });
  it('should allow owner to set fee per unit', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [owner] = await ethers.getSigners();
    await expect(factory.setFeePerUnit(ZERO_ADDRESS, 100))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(ZERO_ADDRESS, 100);
    expect(await factory.defaultFeePerUnit()).to.equal(100);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(100);
    expect(await factory.feePerUnit(owner.address)).to.equal(100);
    await expect(factory.setFeePerUnit(ZERO_ADDRESS, 200))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(ZERO_ADDRESS, 200);
    expect(await factory.defaultFeePerUnit()).to.equal(200);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(200);
    expect(await factory.feePerUnit(owner.address)).to.equal(200);
    await expect(factory.setFeePerUnit(owner.address, 10))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(owner.address, 10);
    expect(await factory.defaultFeePerUnit()).to.equal(200);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(200);
    expect(await factory.feePerUnit(owner.address)).to.equal(10);
    await expect(factory.setFeePerUnit(owner.address, 0))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(owner.address, 0);
    expect(await factory.defaultFeePerUnit()).to.equal(200);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(200);
    expect(await factory.feePerUnit(owner.address)).to.equal(200);
    await expect(factory.setFeePerUnit(ZERO_ADDRESS, 0))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(ZERO_ADDRESS, 0);
    expect(await factory.defaultFeePerUnit()).to.equal(0);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(0);
    expect(await factory.feePerUnit(owner.address)).to.equal(0);
    await expect(factory.setFeePerUnit(owner.address, 10))
      .to.emit(factory, 'FeePerUnitSet')
      .withArgs(owner.address, 10);
    expect(await factory.defaultFeePerUnit()).to.equal(0);
    expect(await factory.feePerUnit(ZERO_ADDRESS)).to.equal(0);
    expect(await factory.feePerUnit(owner.address)).to.equal(10);
  });
  it('should restrict others to set fee per unit', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [_, other] = await ethers.getSigners();
    await expect(factory.connect(other).setFeePerUnit(ZERO_ADDRESS, 100))
      .to.be.revertedWith(/Ownable/);
    await expect(factory.connect(other).setFeePerUnit(other.address, 100))
      .to.be.revertedWith(/Ownable/);
  });
  it('should allow owner to set default fee per unit', async function () {
    // Covered by: should allow owner to set fee per unit.
  });
  it('should allow owner to withdraw native currency', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [_, other, user] = await ethers.getSigners();
    await expect(other.sendTransaction({ to: factory.address, value: 200 }))
      .to.changeEtherBalance(factory.address, 200);
    await expect(factory.withdraw(ZERO_ADDRESS, user.address, 50))
      .to.changeEtherBalance(user.address, 50)
      .to.changeEtherBalance(factory.address, -50)
      .to.emit(factory, 'Withdraw')
      .withArgs(ZERO_ADDRESS, user.address, 50);
    await expect(factory.withdraw(ZERO_ADDRESS, other.address, 150))
      .to.changeEtherBalance(other.address, 150)
      .to.changeEtherBalance(factory.address, -150)
      .to.emit(factory, 'Withdraw')
      .withArgs(ZERO_ADDRESS, other.address, 150);
  });
  it('should allow owner to withdraw tokens', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [_, other, user] = await ethers.getSigners();
    await link.transfer(factory.address, 200);
    await expect(factory.withdraw(link.address, user.address, 50))
      .to.changeTokenBalance(link, user.address, 50)
      .to.changeTokenBalance(link, factory.address, -50)
      .to.emit(factory, 'Withdraw')
      .withArgs(link.address, user.address, 50);
    await expect(factory.withdraw(link.address, other.address, 150))
      .to.changeTokenBalance(link, other.address, 150)
      .to.changeTokenBalance(link, factory.address, -150)
      .to.emit(factory, 'Withdraw')
      .withArgs(link.address, other.address, 150);
  });
  it('should restrict others to withdraw native currency', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [owner, other, user] = await ethers.getSigners();
    await other.sendTransaction({ to: factory.address, value: 200 });
    await expect(factory.connect(other).withdraw(ZERO_ADDRESS, owner.address, 50))
      .to.be.revertedWith(/Ownable/);
    await expect(factory.connect(user).withdraw(ZERO_ADDRESS, user.address, 50))
      .to.be.revertedWith(/Ownable/);
  });
  it('should restrict others to withdraw tokens', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other, user] = await ethers.getSigners();
    await link.transfer(factory.address, 200);
    await expect(factory.connect(other).withdraw(link.address, owner.address, 50))
      .to.be.revertedWith(/Ownable/);
    await expect(factory.connect(user).withdraw(link.address, user.address, 50))
      .to.be.revertedWith(/Ownable/);
  });
  it('should allow receiving native currency and emit a Payment event', async function () {
    const { factory } = await loadFixture(deployFactory);
    const [owner, other, user] = await ethers.getSigners();
    await expect(owner.sendTransaction({ to: factory.address, value: 200 }))
      .to.changeEtherBalance(factory.address, 200)
      .to.emit(factory, 'Payment')
      .withArgs(owner.address, 200);
    await expect(other.sendTransaction({ to: factory.address, value: 100 }))
      .to.changeEtherBalance(factory.address, 100)
      .to.emit(factory, 'Payment')
      .withArgs(other.address, 100);
    await expect(user.sendTransaction({ to: factory.address, value: 0 }))
      .to.changeEtherBalance(factory.address, 0)
      .to.emit(factory, 'Payment')
      .withArgs(user.address, 0);
  });
  it('should allow receiving LINK through ERC677 and emit a PaymentLINK event', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other, user] = await ethers.getSigners();
    await expect(link.transferAndCall(factory.address, 200, '0x'))
      .to.changeTokenBalance(link, factory.address, 200)
      .to.changeTokenBalance(link, owner.address, -200)
      .to.emit(factory, 'PaymentLINK')
      .withArgs(owner.address, 200);
    await expect(link.connect(other).transferAndCall(factory.address, 100, '0x'))
      .to.changeTokenBalance(link, factory.address, 100)
      .to.changeTokenBalance(link, other.address, -100)
      .to.emit(factory, 'PaymentLINK')
      .withArgs(other.address, 100);
    await expect(link.connect(user).transferAndCall(factory.address, 0, '0x11'))
      .to.changeTokenBalance(link, factory.address, 0)
      .to.changeTokenBalance(link, user.address, 0)
      .to.emit(factory, 'PaymentLINK')
      .withArgs(user.address, 0);
  });
  it('should restrict receiving other tokens through ERC677', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other, user] = await ethers.getSigners();
    await expect(factory.onTokenTransfer(other.address, 50, '0x'))
      .to.be.revertedWithCustomError(factory, 'AcceptingOnlyLINK');
    await expect(factory.onTokenTransfer(owner.address, 50, '0x11'))
      .to.be.revertedWithCustomError(factory, 'AcceptingOnlyLINK');
    await expect(factory.connect(user).onTokenTransfer(other.address, 100, '0x11'))
      .to.be.revertedWithCustomError(factory, 'AcceptingOnlyLINK');
  });
  it('should allow deploying lootboxes when fee is zero', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other] = await ethers.getSigners();
    const deployTx = factory.deployLootbox('', 0);
    await deployTx;
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    await expect(deployTx)
      .to.emit(factory, 'Deployed')
      .withArgs(deployedLootbox, owner.address, 0);
    await expect(factory.connect(other).deployLootbox('', 0))
      .to.emit(factory, 'Deployed')
      .withArgs(anyValue, other.address, 0);
  });
  it('should allow deploying lootboxes when fee is positive', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other] = await ethers.getSigners();
    await factory.setFeePerDeploy(100);
    const deployTx = factory.deployLootbox('', 0, { value: 100 });
    await deployTx;
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    await expect(deployTx)
      .to.changeEtherBalance(factory.address, 100)
      .to.emit(factory, 'Deployed')
      .withArgs(deployedLootbox, owner.address, 100);
    await expect(factory.connect(other).deployLootbox('', 0, { value: 200 }))
      .to.changeEtherBalance(factory.address, 200)
      .to.emit(factory, 'Deployed')
      .withArgs(anyValue, other.address, 200);
  });
  it('should restrict deploying lootboxes with insufficient payment', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other] = await ethers.getSigners();
    await factory.setFeePerDeploy(1000);
    await expect(factory.deployLootbox('', 0))
      .to.be.revertedWithCustomError(factory, 'InsufficientPayment');
    await expect(factory.connect(other).deployLootbox('', 999))
      .to.be.revertedWithCustomError(factory, 'InsufficientPayment');
  });
  it('should allow deploying lootboxes with different ids and the same owner', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner] = await ethers.getSigners();
    await factory.deployLootbox('', 0);
    await factory.deployLootbox('', 1);
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    const deployedLootbox2 = await factory.getLootbox(owner.address, 1);
    expect(deployedLootbox).to.not.equal(deployedLootbox2);
  });
  it('should restrict deploying lootboxes with duplicate ids and the same owner', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    await factory.deployLootbox('', 0);
    await expect(factory.deployLootbox('another', 0))
      .to.be.revertedWithCustomError(factory, 'AlreadyDeployed');
    await expect(factory.deployLootbox('', 0))
      .to.be.revertedWithCustomError(factory, 'AlreadyDeployed');
  });
  it('should allow deploying lootboxes with duplicate ids but different owners', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner, other] = await ethers.getSigners();
    await factory.deployLootbox('', 0);
    await factory.connect(other).deployLootbox('', 0);
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    const deployedLootbox2 = await factory.getLootbox(other.address, 0);
    expect(deployedLootbox).to.not.equal(deployedLootbox2);
  });
  it('should allow to get a deployed lootbox address by owner and id', async function () {
    const { factory, link } = await loadFixture(deployFactory);
    const [owner] = await ethers.getSigners();
    await factory.deployLootbox('someUri', 0);
    const deployedLootbox = await factory.getLootbox(owner.address, 0);
    const lootbox = await ethers.getContractAt('LootboxInterface', deployedLootbox);
    const adminRole = await lootbox.DEFAULT_ADMIN_ROLE();
    expect(await lootbox.uri(0)).to.equal('someUri');
    expect(await lootbox.hasRole(adminRole, owner.address)).to.be.true;
    expect(await lootbox.FACTORY()).to.equal(factory.address);
  });
});
