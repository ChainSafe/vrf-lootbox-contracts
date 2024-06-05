// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC1155Base} from './ERC1155Base.sol';

contract ERC1155ERC20Wrapper is ERC1155Base {
  using SafeERC20 for IERC20;

  IERC20 public underlying;
  uint256 public totalWrapped;
  bytes32 public constant DO_NOT_UNWRAP = keccak256('DO_NOT_UNWRAP');

  event Recovery(address caller, IERC20 token, uint256 amount);

  error InsufficientBalance();
  error ZeroAddress();

  constructor(IERC20 _underlying, address owner) ERC1155Base() {
    if (address(_underlying) == address(0)) revert ZeroAddress();
    if (owner == address(0)) revert ZeroAddress();
    _grantRole(DEFAULT_ADMIN_ROLE, owner);
    _grantRole(MINTER_ROLE, owner);
    _grantRole(PAUSER_ROLE, owner);
    underlying = _underlying;
  }

  function mint(address account, uint256 id, uint256 amount, bytes memory data)
    public virtual override
  {
    (uint256[] memory ids, uint256[] memory amounts) = asSingletonArrays(id, amount);
    _wrap(ids, amounts);
    super.mint(account, id, amount, data);
  }

  function mintBatch(address account, uint256[] memory ids, uint256[] memory amounts, bytes memory data)
    public virtual override
  {
    _wrap(ids, amounts);
    super.mintBatch(account, ids, amounts, data);
  }

  function burn(address account, uint256 id, uint256 amount)
    public virtual override
  {
    (uint256[] memory ids, uint256[] memory amounts) = asSingletonArrays(id, amount);
    _unwrap(account, _msgSender(), ids, amounts);
  }

  function burnBatch(address account, uint256[] memory ids, uint256[] memory amounts)
    public virtual override
  {
    _unwrap(account, _msgSender(), ids, amounts);
  }

  function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes memory data)
    public virtual override
  {
    if (_isDoNotUnwrap(data)) {
      super.safeTransferFrom(from, to, id, amount, data);
      return;
    }
    (uint256[] memory ids, uint256[] memory amounts) = asSingletonArrays(id, amount);
    _unwrap(from, to, ids, amounts);
  }

  function safeBatchTransferFrom(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory amounts,
    bytes memory data
  ) public virtual override {
    if (_isDoNotUnwrap(data)) {
      super.safeBatchTransferFrom(from, to, ids, amounts, data);
      return;
    }
    _unwrap(from, to, ids, amounts);
  }

  function recover(IERC20 token, uint amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (amount == 0) {
      amount = token.balanceOf(address(this));
    }
    if (token == underlying && amount > (token.balanceOf(address(this)) - totalWrapped)) {
      revert InsufficientBalance();
    }
    token.safeTransfer(_msgSender(), amount);
    emit Recovery(_msgSender(), token, amount);
  }

  function _wrap(
    uint256[] memory ids,
    uint256[] memory amounts
  ) private {
    uint256 underlyingAmount = _productsSum(ids, amounts);
    underlying.safeTransferFrom(_msgSender(), address(this), underlyingAmount);
    totalWrapped = totalWrapped + underlyingAmount;
  }

  function _unwrap(
    address from,
    address to, 
    uint256[] memory ids,
    uint256[] memory amounts
  ) private {
    super.burnBatch(from, ids, amounts);
    uint256 underlyingAmount = _productsSum(ids, amounts);
    underlying.safeTransfer(to, underlyingAmount);
    totalWrapped = totalWrapped - underlyingAmount;
  }

  function _productsSum(
    uint256[] memory ids,
    uint256[] memory amounts
  ) private pure returns(uint256) {
    uint256 len = amounts.length;
    uint256 underlyingAmount = 0;
    for (uint256 i = 0; i < len; ++i) {
      underlyingAmount = underlyingAmount + (ids[i] * amounts[i]);
    }
    return underlyingAmount;
  }

  function _isDoNotUnwrap(bytes memory data) private pure returns(bool) {
    return data.length >= 32 && abi.decode(data, (bytes32)) == DO_NOT_UNWRAP;
  }

  // As seen in @openzeppelin/contracts/token/ERC1155/ERC1155.sol
  function asSingletonArrays(
    uint256 element1,
    uint256 element2
  ) private pure returns (uint256[] memory array1, uint256[] memory array2) {
    /// @solidity memory-safe-assembly
    assembly {
      // Load the free memory pointer
      array1 := mload(0x40)
      // Set array length to 1
      mstore(array1, 1)
      // Store the single element at the next word after the length (where content starts)
      mstore(add(array1, 0x20), element1)

      // Repeat for next array locating it right after the first array
      array2 := add(array1, 0x40)
      mstore(array2, 1)
      mstore(add(array2, 0x20), element2)

      // Update the free memory pointer by pointing after the second array
      mstore(0x40, add(array2, 0x40))
    }
  }
}
