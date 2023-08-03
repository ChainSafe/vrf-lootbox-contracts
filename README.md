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

### First step, launch a local mainnet fork (repeat if things stop working). This will give you a local node running on http://localhost:8545/

    npm run node

### Second step, deploy a lootbox factory

    npm run hardhat -- deploy-factory

## All the next steps are for development and testing purposes only, and will not work on real networks

### You can perform a full dev setup with a single command

    npm run hardhat -- devsetup

### For the more fine grained setup use following commands
### Deploy a lootbox and transfer LINK to it. Also deploys a ERC20 with balance 100000, ERC721 with 20 tokens, ERC1155 with 10 tokens with 1000 balance each, and an ERC1155NFT with 15 tokens. All the reward tokens are added to whitelist of the lootbox and the supplier user given supply role

    npm run hardhat -- deploy-lootbox

### Deploy additional lootboxes by specifying an optional `id` parameter, and others

    npm run hardhat -- deploy-lootbox --id 10 --uri "ipfs://somehash" --linkamount 1000

### Supply rewards, as much as needed

    npm run hardhat -- supply-rewards --type ERC20 --amount 1000
    npm run hardhat -- supply-rewards --type ERC1155NFT --tokenid 3
    npm run hardhat -- supply-rewards --type ERC1155 --tokenid 4 --amount 150
    npm run hardhat -- supply-rewards --type ERC721 --tokenid 9

### Set amounts per unit 

    npm run hardhat -- set-amountperunit --type ERC20 --amountperunit 30
    npm run hardhat -- set-amountperunit --type ERC1155 --tokenid 3 --amountperunit 35
    npm run hardhat -- set-amountperunit --type ERC1155 --tokenid 4 --amountperunit 50

### Mint lootboxes to the user. TokenId represents how many rewards user will get per lootbox.

    npm run hardhat -- mint

### After the user submits an open request, fulfill randomness

    npm run hardhat -- fulfill

### You can get help on any command by doing

    npm run hardhat help fulfill
