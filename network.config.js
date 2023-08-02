const networkConfig = {
  '11155111': {
    name: 'sepolia',
    linkToken: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
    vrfV2Wrapper: '0xab18414CD93297B0d12ac29E63Ca20f515b3DB46',
  },
  '5': {
    name: 'goerli',
    linkToken: '0x326C977E6efc84E512bB9C30f76E30c160eD06FB',
    vrfV2Wrapper: '0x708701a1DfF4f478de54383E49a627eD4852C816',
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
