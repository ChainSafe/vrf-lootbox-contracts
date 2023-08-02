# vrf-lootbox-contracts

## Install

    node 18.x is required
    npm install
    npm run compile

## Usage

By default everything is executed on the forked network, and no real transactions being sent.
You can add dev keys to your wallet (like MetaMask) in order to interract with the contracts on the local node.
The keys are:

    57b26bc4bcfd781dcab2fbda189bbf9eb124c7084690571ce185294cbb3d010a Deployer
    7bb779a88af05bc9bc0d0a1da4357cced604f545459a532f92c3eb6d42f1900c Supplier
    8c2fa29c9d3b9dfd7e1230296e1038f8e27d16ce4a5bbbbcb629ac8f0f00e9c9 User

### First step, launch a local mainnet fork (repeat if things stop working)

    npm run node

### Second step, deploy a lootbox factory

    npm run hardhat deploy-factory

## All the next steps are for development and testing purposes only, and will not work on real networks.

### Deploy a lootbox and transfer LINK to it

    npm run hardhat deploy-lootbox

### Deploy additional lootboxes by specifying an optional `id` parameter, and others

    npm run hardhat deploy-lootbox --id=10 --uri="ipfs://somehash" --linkamount=1000
