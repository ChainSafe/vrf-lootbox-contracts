# vrf-lootbox-contracts

## Install

    node 18.x is required
    npm install
    npm run compile

## Usage

By default everything is executed on the forked network, and no real transactions being sent.

### First step, launch a local mainnet fork (repeat if things stop working)

    npm run node

### Second step, deploy a lootbox factory

    npm run hardhat deploy-factory

## All the next steps are for development and testing purposes only, and will not work on real networks.

### Deploy a lootbox and transfer LINK to it

    npm run hardhat deploy-lootbox

### Deploy additional lootboxes by specifying an optional `id` parameter, and others

    npm run hardhat deploy-lootbox --id=10 --uri="ipfs://somehash" --linkamount=1000
