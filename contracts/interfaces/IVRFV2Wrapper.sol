// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {AggregatorV3Interface} from '@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol';

interface IVRFV2Wrapper {
  function LINK_ETH_FEED() external pure returns (AggregatorV3Interface); 
}
