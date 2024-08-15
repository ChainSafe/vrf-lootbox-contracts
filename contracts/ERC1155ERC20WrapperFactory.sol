// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC1155ERC20Wrapper, IERC20, ERC1155ERC20Wrapper} from './ERC1155ERC20Wrapper.sol';
import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {Clones} from '@openzeppelin/contracts/proxy/Clones.sol';

contract ERC1155ERC20WrapperFactory is Context {
  using Clones for address;

  address public immutable WRAPPER;

  event Deployed(address wrapper, address owner);

  constructor() {
    WRAPPER = address(new ERC1155ERC20Wrapper(address(this)));
  }

  function deployWrapper(IERC20 _underlying, address owner) public returns (address) {
    address predeployed = getDeployedAddress(_msgSender(), _underlying);
    if (predeployed.code.length > 0) {
      return predeployed;
    }
    address wrapper = WRAPPER.cloneDeterministic(keccak256(abi.encodePacked(_msgSender(), _underlying)));
    ERC1155ERC20Wrapper(wrapper).initialize(_underlying, owner);
    emit Deployed(wrapper, owner);
    return wrapper;
  }

  function deployWrapperWithSetup(
    IERC20 _underlying,
    address owner,
    address to,
    uint256[] memory ids,
    uint256[] memory amounts
  ) external returns (address) {
    address wrapper = deployWrapper(_underlying, owner);
    ERC1155ERC20Wrapper(wrapper).mintBatchAndTransfer(
      owner, to, ids, amounts, abi.encodePacked(keccak256('DO_NOT_UNWRAP'))
    );
    return wrapper;
  }

  function getDeployedAddress(address _deployer, IERC20 _underlying) public view returns (address) {
    return Clones.predictDeterministicAddress(
      WRAPPER,
      keccak256(abi.encodePacked(_deployer, _underlying)),
      address(this)
    );
  }
}
