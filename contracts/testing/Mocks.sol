// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {ERC721} from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import {ERC1155} from '@openzeppelin/contracts/token/ERC1155/ERC1155.sol';

contract MockERC20 is ERC20 {
  constructor(uint _supply) ERC20('MockERC20', 'ERC20') {
    _mint(msg.sender, _supply);
  }
}

contract MockERC721 is ERC721 {
  constructor(uint _supply) ERC721('MockERC721', 'ERC721') {
    for (uint i = 0; i < _supply; ++i) {
      _mint(msg.sender, i);
    }
  }
}

contract MockERC1155 is ERC1155 {
  constructor(uint _tokens, uint _supply) ERC1155('https://bafybeicxxp4o5vxpesym2cvg4cqmxnwhwgpqawhhvxttrz2dlpxjyiob64.ipfs.nftstorage.link/{id}') {
    for (uint i = 0; i < _tokens; ++i) {
      _mint(msg.sender, i, _supply, '');
    }
  }
}

contract MockERC1155NFT is ERC1155 {
  constructor(uint _supply) ERC1155('https://bafybeicxxp4o5vxpesym2cvg4cqmxnwhwgpqawhhvxttrz2dlpxjyiob64.ipfs.nftstorage.link/{id}') {
    for (uint i = 0; i < _supply; ++i) {
      _mint(msg.sender, i, 1, '');
    }
  }
}

contract TestnetERC20 is ERC20 {
  constructor(uint _supply, address _holder) ERC20('TestnetERC20', 'ERC20') {
    _mint(_holder, _supply);
  }

  function mintTo(address _to, uint _amount) public {
    require(_amount <= 1000000 ether);
    _mint(_to, _amount);
  }

  function mint(uint _amount) external {
    mintTo(msg.sender, _amount);
  }
}

contract TestnetERC721 is ERC721 {
  uint public nextId = 0;
  constructor(uint _supply, address _holder) ERC721('TestnetERC721', 'ERC721') {
    mintTo(_holder, _supply);
  }

  function mintTo(address _to, uint _amount) public {
    for (uint i = 0; i < _amount; ++i) {
      _mint(_to, nextId++);
    }
  }

  function mint(uint _amount) external {
    mintTo(msg.sender, _amount);
  }
}

contract TestnetERC1155 is ERC1155 {
  constructor(uint _tokens, uint _supply, address _holder) ERC1155('https://bafybeicxxp4o5vxpesym2cvg4cqmxnwhwgpqawhhvxttrz2dlpxjyiob64.ipfs.nftstorage.link/{id}') {
    for (uint i = 0; i < _tokens; ++i) {
      mintTo(_holder, i, _supply);
    }
  }

  function mintTo(address _to, uint _id, uint _amount) public {
    _mint(_to, _id, _amount, '');
  }

  function mint(uint _id, uint _amount) external {
    mintTo(msg.sender, _id, _amount);
  }
}

contract TestnetERC1155NFT is ERC1155 {
  uint public nextId = 0;
  constructor(uint _supply, address _holder) ERC1155('https://bafybeicxxp4o5vxpesym2cvg4cqmxnwhwgpqawhhvxttrz2dlpxjyiob64.ipfs.nftstorage.link/{id}') {
    mintTo(_holder, _supply);
  }

  function mintTo(address _to, uint _amount) public {
    for (uint i = 0; i < _amount; ++i) {
      _mint(_to, nextId++, 1, '');
    }
  }

  function mint(uint _amount) external {
    mintTo(msg.sender, _amount);
  }
}