// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC1155ERC20Wrapper, IERC20} from './ERC1155ERC20Wrapper.sol';

contract ERC1155ERC20WrapperFactory {
  event Deployed(address wrapper, address owner);

  function deployWrapper(IERC20 _underlying, address owner) external returns (address) {
    ERC1155ERC20Wrapper wrapper = new ERC1155ERC20Wrapper(_underlying, owner);
    emit Deployed(address(wrapper), owner);
    return address(wrapper);
  }
}
