// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

contract Wallet is Ownable {
  constructor() Ownable(msg.sender) {}

  function forward(address payable to, uint256 value, bytes memory data) external payable onlyOwner {
    to.call{value: value}(data);
  }

  function delegate(address payable to, bytes memory data) external payable onlyOwner {
    to.delegatecall(data);
  }
}
