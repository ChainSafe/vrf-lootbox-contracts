const networkConfig = {
  '11155111': {
    name: 'sepolia',
    linkToken: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
    vrfV2Wrapper: '0xab18414CD93297B0d12ac29E63Ca20f515b3DB46',
  },
  '4002': {
    name: 'fantomtest',
    linkToken: '0xfaFedb041c0DD4fA2Dc0d87a6B0979Ee6FA7af5F',
    vrfV2Wrapper: '0x38336BDaE79747a1d2c4e6C67BBF382244287ca6',
  },
  '43113': {
    name: 'fuji',
    linkToken: '0x0b9d5D9136855f6FEc3c0993feE6E9CE8a297846',
    vrfV2Wrapper: '0x9345AC54dA4D0B5Cda8CB749d8ef37e5F02BBb21',
  },
  '80001': {
    name: 'mumbai',
    linkToken: '0x326C977E6efc84E512bB9C30f76E30c160eD06FB',
    vrfV2Wrapper: '0x99aFAf084eBA697E584501b8Ed2c0B37Dd136693',
  },
  '97': {
    name: 'bsctest',
    linkToken: '0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06',
    vrfV2Wrapper: '0x699d428ee890d55D56d5FC6e26290f3247A762bd',
  },
  '1': {
    name: 'mainnet',
    linkToken: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    vrfV2Wrapper: '0x5A861794B927983406fCE1D062e00b9368d97Df6',
  },
  '31337': {
    name: 'hardhat',
    linkToken: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    linkHolder: '0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489',
    vrfV2Wrapper: '0x5A861794B927983406fCE1D062e00b9368d97Df6',
  },
};

module.exports = networkConfig;
