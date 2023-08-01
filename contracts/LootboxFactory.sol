// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Address} from '@openzeppelin/contracts/utils/Address.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC677ReceiverInterface} from '@chainlink/contracts/src/v0.8/interfaces/ERC677ReceiverInterface.sol';
import {ILootboxFactory} from './interfaces/ILootboxFactory.sol';
import {Lootbox} from './Lootbox.sol';

/// TODO: Reduce contract size.
/// @title Lootbox Factory
/// @author ChainSafe Systems.
/// @notice Contract that deploys lootbox contracts and manages fees.
contract LootboxFactory is ILootboxFactory, ERC677ReceiverInterface, Ownable {
  using Address for address payable;
  using SafeERC20 for IERC20;

  address public immutable LINK;
  address public immutable VRFV2WRAPPER;

  uint public feePerDeploy = 0;
  mapping(address lootbox => uint feePerUnit) private fees;
  
  event Payment(address lootbox, uint value);
  event PaymentLINK(address lootbox, uint amount);
  event Withdraw(address token, address to, uint amount);
  event Deployed(address lootbox, address owner, uint payment);
  event FeePerDeploySet(uint value);
  event FeePerUnitSet(address lootbox, uint value);

  error InsufficientPayment();
  error AcceptingOnlyLINK();

  constructor(
    address _link,
    address _vrfV2Wrapper
  ) {
    LINK = _link;
    VRFV2WRAPPER = _vrfV2Wrapper;
  }

  function deployLootbox(string calldata _uri) external payable returns (address) {
    if (msg.value < feePerDeploy) revert InsufficientPayment();
    address lootbox = address(new Lootbox(LINK, VRFV2WRAPPER, _uri, _msgSender()));
    emit Deployed(lootbox, _msgSender(), msg.value);
    return lootbox;
  }

  function defaultFeePerUnit() external view returns (uint) {
    return fees[address(0)];
  }

  function feePerUnit(address _lootbox) external view override returns (uint) {
    uint fee = fees[_lootbox];
    if (fee > 0) {
      return fee;
    }
    return fees[address(0)];
  }

  function setFeePerDeploy(uint _feePerDeploy) external onlyOwner() {
    feePerDeploy = _feePerDeploy;
    emit FeePerDeploySet(_feePerDeploy);
  }

  function setFeePerUnit(address _lootbox, uint _value) external onlyOwner() {
    fees[_lootbox] = _value;
    emit FeePerUnitSet(_lootbox, _value);
  }

  function withdraw(address _token, address payable _to, uint _amount) external onlyOwner() {
    emit Withdraw(_token, _to, _amount);
    if (_token == address(0)) {
      _to.sendValue(_amount);
      return;
    }
    IERC20(_token).safeTransfer(_to, _amount);
  }

  receive() external payable override {
    emit Payment(msg.sender, msg.value);
  }

  function onTokenTransfer(address _lootbox, uint _amount, bytes calldata) external override {
    if (msg.sender != LINK) revert AcceptingOnlyLINK();
    emit PaymentLINK(_lootbox, _amount);
  }
}
