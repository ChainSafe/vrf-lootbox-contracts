const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { expect } = require('chai');
const { linkToken, vrfV2Wrapper } = require('../network.config.js')['31337'];

describe('LootboxFactory', function () {
  const deployFactory = async (linkAddress, wrapperAddress) => {
    const lootboxFactoryFactory = await ethers.getContractFactory('LootboxFactory');
    const lootboxFactory = await lootboxFactoryFactory.deploy(
      linkAddress || linkToken,
      wrapperAddress || vrfV2Wrapper
    );
    await lootboxFactory.deployed();
    return lootboxFactory;
  };

  it('should deploy lootbox factory and have valid defaults', async function () {
    const factory = await loadFixture(deployFactory);
    expect(await factory.LINK()).to.equal(linkToken);
    expect(await factory.VRFV2WRAPPER()).to.equal(vrfV2Wrapper);
    expect(await factory.feePerDeploy()).to.equal(0);
    expect(await factory.defaultFeePerUnit()).to.equal(0);
    const [someone, another] = await ethers.getSigners();
    const factory2 = await deployFactory(someone.address, another.address);
    expect(await factory2.LINK()).to.equal(someone.address);
    expect(await factory2.VRFV2WRAPPER()).to.equal(another.address);
  });
  it.skip('should allow owner to set fee per deploy', async function () {});
  it.skip('should restrict others to set fee per deploy', async function () {});
  it.skip('should allow owner to set fee per unit', async function () {});
  it.skip('should restrict others to set fee per unit', async function () {});
  it.skip('should allow owner to set default fee per unit', async function () {});
  it.skip('should allow owner to withdraw native currency', async function () {});
  it.skip('should allow owner to withdraw tokens', async function () {});
  it.skip('should restrict others to withdraw native currency', async function () {});
  it.skip('should restrict others to withdraw tokens', async function () {});
  it.skip('should allow receiving native currency and emit a Payment event', async function () {});
  it.skip('should allow receiving LINK through ERC677 and emit a PaymentLINK event', async function () {});
  it.skip('should restrict receiving other tokens through ERC677', async function () {});
  it.skip('should allow deploying lootboxes when fee is zero', async function () {});
  it.skip('should allow deploying lootboxes when fee is positive', async function () {});
  it.skip('should restrict deploying lootboxes with insufficient payment', async function () {});
  it.skip('should allow deploying lootboxes with different ids and the same owner', async function () {});
  it.skip('should restrict deploying lootboxes with duplicate ids and the same owner', async function () {});
  it.skip('should allow deploying lootboxes with duplicate ids but different owners', async function () {});
  it.skip('should allow to get a deployed lootbox address by owner and id', async function () {});
});
