const {
  time,
  loadFixture,
} = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { expect } = require('chai');

describe('Lootbox', function () {
  it.skip('should deploy lootbox and have valid defaults', async function () {});

  it.skip('should allow admin to set base URI', async function () {});
  it.skip('should restrict others to set base URI', async function () {});

  it.skip('should allow admin to add suppliers', async function () {});
  it.skip('should not emit events when adding duplicate suppliers', async function () {});
  it.skip('should restrict others to add suppliers', async function () {});
  it.skip('should allow admin to remove suppliers', async function () {});
  it.skip('should not emit events when removing absent suppliers', async function () {});
  it.skip('should restrict others to remove suppliers', async function () {});
  it.skip('should list suppliers', async function () {});

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
});
