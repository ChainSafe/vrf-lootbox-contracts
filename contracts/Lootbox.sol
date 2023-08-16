// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import {IERC1155} from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';
import {IERC721Receiver} from '@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol';
import {ERC721Holder} from '@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol';
import {ERC1155PresetMinterPauser} from '@openzeppelin/contracts/token/ERC1155/presets/ERC1155PresetMinterPauser.sol';
import {ERC1155Holder, ERC1155Receiver} from '@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {SafeCast} from '@openzeppelin/contracts/utils/math/SafeCast.sol';
import {Address} from '@openzeppelin/contracts/utils/Address.sol';
import {VRFCoordinatorV2Interface} from '@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol';
import {ERC677ReceiverInterface} from '@chainlink/contracts/src/v0.8/interfaces/ERC677ReceiverInterface.sol';
import {VRFV2WrapperInterface} from '@chainlink/contracts/src/v0.8/interfaces/VRFV2WrapperInterface.sol';
import {VRFV2WrapperConsumerBase} from '@chainlink/contracts/src/v0.8/VRFV2WrapperConsumerBase.sol';
import {ILootboxFactory} from './interfaces/ILootboxFactory.sol';
import {IVRFV2Wrapper, AggregatorV3Interface} from './interfaces/IVRFV2Wrapper.sol';

//  $$$$$$\  $$\   $$\  $$$$$$\  $$$$$$\ $$\   $$\  $$$$$$\   $$$$$$\  $$$$$$$$\ $$$$$$$$\ 
// $$  __$$\ $$ |  $$ |$$  __$$\ \_$$  _|$$$\  $$ |$$  __$$\ $$  __$$\ $$  _____|$$  _____|
// $$ /  \__|$$ |  $$ |$$ /  $$ |  $$ |  $$$$\ $$ |$$ /  \__|$$ /  $$ |$$ |      $$ |      
// $$ |      $$$$$$$$ |$$$$$$$$ |  $$ |  $$ $$\$$ |\$$$$$$\  $$$$$$$$ |$$$$$\    $$$$$\    
// $$ |      $$  __$$ |$$  __$$ |  $$ |  $$ \$$$$ | \____$$\ $$  __$$ |$$  __|   $$  __|   
// $$ |  $$\ $$ |  $$ |$$ |  $$ |  $$ |  $$ |\$$$ |$$\   $$ |$$ |  $$ |$$ |      $$ |      
// \$$$$$$  |$$ |  $$ |$$ |  $$ |$$$$$$\ $$ | \$$ |\$$$$$$  |$$ |  $$ |$$ |      $$$$$$$$\ 
//  \______/ \__|  \__|\__|  \__|\______|\__|  \__| \______/ \__|  \__|\__|      \________|                                                                                                                                                                              
                                                                                        
// $$\       $$$$$$\   $$$$$$\ $$$$$$$$\ $$$$$$$\   $$$$$$\  $$\   $$\ $$$$$$$$\  $$$$$$\  
// $$ |     $$  __$$\ $$  __$$\\__$$  __|$$  __$$\ $$  __$$\ $$ |  $$ |$$  _____|$$  __$$\ 
// $$ |     $$ /  $$ |$$ /  $$ |  $$ |   $$ |  $$ |$$ /  $$ |\$$\ $$  |$$ |      $$ /  \__|
// $$ |     $$ |  $$ |$$ |  $$ |  $$ |   $$$$$$$\ |$$ |  $$ | \$$$$  / $$$$$\    \$$$$$$\  
// $$ |     $$ |  $$ |$$ |  $$ |  $$ |   $$  __$$\ $$ |  $$ | $$  $$<  $$  __|    \____$$\ 
// $$ |     $$ |  $$ |$$ |  $$ |  $$ |   $$ |  $$ |$$ |  $$ |$$  /\$$\ $$ |      $$\   $$ |
// $$$$$$$$\ $$$$$$  | $$$$$$  |  $$ |   $$$$$$$  | $$$$$$  |$$ /  $$ |$$$$$$$$\ \$$$$$$  |
// \________|\______/  \______/   \__|   \_______/  \______/ \__|  \__|\________| \______/ 

/// @title Lootbox
/// @author ChainSafe Systems: Oleksii (Functionality) Sneakz (Natspec assistance)
/// @notice This contract holds functions used in Chainsafe's SDK, Documentation can be found here: https://docs.gaming.chainsafe.io/current/lootboxes
/// @dev Contract allows users to open a lootbox and receive a random reward. All function calls are tested and have been implemented in ChainSafe's SDK

type RewardInfo is uint248; // 8 bytes unitsAvailable | 23 bytes amountPerUnit
uint constant UNITS_OFFSET = 8 * 23;

contract Lootbox is VRFV2WrapperConsumerBase, ERC721Holder, ERC1155Holder, ERC677ReceiverInterface, ERC1155PresetMinterPauser {
  using SafeERC20 for IERC20;
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableSet for EnumerableSet.UintSet;
  using Address for address payable;
  using SafeCast for uint;

  /*//////////////////////////////////////////////////////////////
                                STATE
  //////////////////////////////////////////////////////////////*/

  enum RewardType {
    UNSET,
    ERC20,
    ERC721,
    ERC1155,
    ERC1155NFT
  }

  struct Reward {
    RewardType rewardType;
    RewardInfo rewardInfo;
    EnumerableSet.UintSet ids; // only 721 and 1155
    mapping(uint => RewardInfo) extraInfo; // only for 1155
  }

  struct AllocationInfo {
    EnumerableSet.UintSet ids;
    mapping(uint => uint) amount; // id 0 for ERC20
  }

  ILootboxFactory public immutable FACTORY;
  AggregatorV3Interface public immutable LINK_ETH_FEED;
  uint private constant LINK_UNIT = 1e18;

  uint public unitsSupply; // Supply of units.
  EnumerableSet.UintSet private lootboxTypes; // Types of lootboxes.
  EnumerableSet.AddressSet private suppliers; // Supplier addresses being used.
  EnumerableSet.AddressSet private allowedTokens; // Tokens allowed for rewards.
  EnumerableSet.AddressSet private inventory; // Tokens available for rewards.
  mapping(address => mapping(uint => uint)) private allocated; // Token => TokenId => Balance. ERC20 and fungible ERC1155 allocated for claiming.
  mapping(address => Reward) private rewards; // Info about reward tokens.
  mapping(address => mapping(address => AllocationInfo)) private allocationInfo; // Claimer => Token => Info.
  mapping(address => EnumerableSet.UintSet) private leftoversExtraIds; // Token ids that are not enough for claiming.

  /*//////////////////////////////////////////////////////////////
                             VRF RELATED
  //////////////////////////////////////////////////////////////*/

  /// @notice The number of blocks confirmed before the request is considered fulfilled
  uint16 private constant REQUEST_CONFIRMATIONS = 3;

  /// @notice The number of random words to request
  uint32 private constant NUMWORDS = 1;

  /// @notice The VRF request struct
  struct Request {
    address opener;
    uint96 unitsToGet;
    uint[] lootIds;
    uint[] lootAmounts;
  }

  /// @notice The VRF request IDs and their corresponding parameters as well as the randomness when fulfilled
  mapping(uint256 => Request) private requests;

  /// @notice The VRF request IDs and their corresponding openers
  mapping(address => uint256) public openerRequests;

  /*//////////////////////////////////////////////////////////////
                                EVENTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a lootbox is openning is requested
  /// @param opener The address of the user that requested the open
  /// @param unitsToGet The amount of lootbox units to receive
  /// @param requestId The ID of the VRF request
  event OpenRequested(address opener, uint256 unitsToGet, uint256 requestId);

  /// @notice Emitted when a randomness request is fulfilled and the lootbox rewards can be claimed
  /// @param requestId The ID of the VRF request
  /// @param randomness The random number that was generated
  event OpenRequestFulfilled(uint256 requestId, uint256 randomness);

  /// @notice Emitted when a randomness request ran out of gas and now must be recovered
  /// @param requestId The ID of the VRF request
  event OpenRequestFailed(uint256 requestId);

  event SupplierAdded(address supplier);

  event SupplierRemoved(address supplier);

  /// @notice Emitted when a new reward token gets whitelisted for supply
  event TokenAdded(address token);

  /// @notice Emitted when a reward token amount per unit changes
  /// @param newSupply The new supply of reward units available
  event AmountPerUnitSet(address token, uint tokenId, uint amountPerUnit, uint newSupply);

  /// @notice Emitted when the lootbox rewards are claimed
  /// @param opener The address of the user that received the rewards
  /// @param token The rewarded token contract address
  /// @param tokenId The internal tokenId for ERC721 and ERC1155
  /// @param amount The amount of claimed tokens
  event RewardsClaimed(address opener, address token, uint tokenId, uint amount);

  /*//////////////////////////////////////////////////////////////
                                ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice There are no tokens to put in the lootbox
  error NoTokens();

  /// @notice The tokens array length does not match the perUnitAmounts array length
  error InvalidLength();

  /// @notice Supplying 1155NFT with amount > 1
  error InvalidTokenAmount();

  /// @notice The amount to open is zero
  error ZeroAmount();

  /// @notice Token not allowed as reward
  error TokenDenied(address token);

  /// @notice Deposits only allowed from whitelisted addresses
  error SupplyDenied(address from);

  /// @notice The amount to open exceeds the supply
  error SupplyExceeded(uint256 supply, uint256 unitsToGet);

  /// @notice Has to finish the open request first
  error PendingOpenRequest();

  /// @notice Has to open some lootboxes first
  error NothingToClaim();

  /// @notice Reward type is immutable
  error ModifiedRewardType(RewardType oldType, RewardType newType);

  /// @notice Only LINK could be sent with an ERC677 call
  error AcceptingOnlyLINK();

  /// @notice Not enough pay for a VRF request
  error InsufficientPayment();

  /// @notice Not enough pay for a lootbox opening fee
  error InsufficientFee();

  /// @notice There should be a failed VRF request for recovery
  error NothingToRecover();

  /// @notice LINK price must be positive from an oracle
  error InvalidLinkPrice(int value);

  /// @notice Zero value ERC1155 supplies are not alloved
  error ZeroSupply(address token, uint id);

  /// @notice Function could only be called by this contract itself
  error OnlyThis();

  /// @notice Unexpected reward type for current logic
  error UnexpectedRewardType(RewardType rewardType);

  /// @notice Units should fit in 64 bits
  error UnitsOverflow(uint value);

  /// @notice Amount per unit should fit in 184 bits
  error AmountPerUnitOverflow(uint value);

  /// @notice Token id was already present in the inventory with units set to 0
  error DepositStateCorruption(address token, uint tokenId);

  /// @notice Token was already present in the inventory with units set to 0
  error InventoryStateCorruption(address token);

  /// @notice Not enough gas is provided for opening
  error InsufficientGas();

  /// @notice Lootbox id represents the number of rewrad units it will produce, so it should be > 0 and < 256
  error InvalidLootboxType();

  /// @notice The request is either already failed/fulfilled or was never created
  error InvalidRequestAllocation(uint requestId);

  /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  /// @notice Deploys a new Lootbox contract with the given parameters.
  /// @param _link The ChainLink LINK token address.
  /// @param _vrfV2Wrapper The ChainLink VRFV2Wrapper contract address.
  /// @param _uri The Lootbox ERC1155 base URI.
  /// @param _owner The admin of the lootbox contract.
  constructor(
    address _link,
    address _vrfV2Wrapper,
    string memory _uri,
    address _owner
  ) VRFV2WrapperConsumerBase(_link, _vrfV2Wrapper) ERC1155PresetMinterPauser(_uri) {
    _revokeRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _revokeRole(MINTER_ROLE, _msgSender());
    _revokeRole(PAUSER_ROLE, _msgSender());
    _setupRole(DEFAULT_ADMIN_ROLE, _owner);
    _setupRole(MINTER_ROLE, _owner);
    _setupRole(PAUSER_ROLE, _owner);
    FACTORY = ILootboxFactory(payable(msg.sender));
    LINK_ETH_FEED = IVRFV2Wrapper(_vrfV2Wrapper).LINK_ETH_FEED();
  }

  /*//////////////////////////////////////////////////////////////
                        INVENTORY FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Sets the URI for the contract.
  /// @param _baseURI The base URI being used.
  function setURI(string memory _baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setURI(_baseURI);
  }

  /// @notice Adds contract suppliers.
  /// @param _suppliers An array of suppliers being added.
  function addSuppliers(address[] calldata _suppliers) external onlyRole(DEFAULT_ADMIN_ROLE) {
    for (uint i = 0; i < _suppliers.length; ++i) {
      _addSupplier(_suppliers[i]);
    }
  }

  /// @notice Removes contract suppliers.
  /// @param _suppliers An array of suppliers being removed.
  function removeSuppliers(address[] calldata _suppliers) external onlyRole(DEFAULT_ADMIN_ROLE) {
    for (uint i = 0; i < _suppliers.length; ++i) {
      _removeSupplier(_suppliers[i]);
    }
  }

  /// @notice Adds tokens for lootbox usage.
  /// @param _tokens An array of tokens being added.
  function addTokens(address[] calldata _tokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
    for (uint i = 0; i < _tokens.length; ++i) {
      _addToken(_tokens[i]);
    }
  }

  /// @notice Sets the supply of units for lootbox usage.
  /// @param _tokens An array of tokens being added.
  /// @param _ids An array of ids being added.
  /// @param _amountsPerUnit An array of amounts being added.
  function setAmountsPerUnit(address[] calldata _tokens, uint[] calldata _ids, uint[] calldata _amountsPerUnit) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_tokens.length != _ids.length || _tokens.length != _amountsPerUnit.length) revert InvalidLength();
    uint currentSupply = unitsSupply;
    for (uint i = 0; i < _tokens.length; ++i) {
      currentSupply = _setAmountPerUnit(currentSupply, _tokens[i], _ids[i], _amountsPerUnit[i]);
    }
    unitsSupply = currentSupply;
  }

  // TODO: Add inventory withdraw function.

  /// @notice Sets required information when a 721 token is received.
  /// @param from The address the token is coming from.
  /// @param tokenId The id of of the 721 token.
  /// @return onERC721Received if successful.
  function onERC721Received(
    address,
    address from,
    uint256 tokenId,
    bytes memory
  ) public override returns (bytes4) {
    address token = msg.sender;
    if (_not(tokenAllowed(token))) revert TokenDenied(token);
    if (_not(supplyAllowed(from))) revert SupplyDenied(from);
    RewardInfo rewardInfo = rewards[token].rewardInfo;
    RewardType rewardType = rewards[token].rewardType;
    bool isFirstTime = rewardType == RewardType.UNSET;
    if (isFirstTime) {
      rewardInfo = toInfo(0, 1);
      rewards[token].rewardInfo = rewardInfo;
      rewards[token].rewardType = RewardType.ERC721;
    } else if (rewardType != RewardType.ERC721) {
      revert ModifiedRewardType(rewardType, RewardType.ERC721);
    }
    _supplyNFT(rewardInfo, token, tokenId);
    return this.onERC721Received.selector;
  }

  /// @notice Sets required information when a 1155 token batch is received.
  /// @param from The address the token is coming from.
  /// @param ids An array of 1155 ids to be added to the account.
  /// @param values An array of values to be added to the account.
  /// @return onERC1155BatchReceived if successful.
  function onERC1155BatchReceived(
    address,
    address from,
    uint256[] memory ids,
    uint256[] memory values,
    bytes memory
  ) public override returns (bytes4) {
    address token = msg.sender;
    if (_not(tokenAllowed(token))) revert TokenDenied(token);
    if (_not(supplyAllowed(from))) revert SupplyDenied(from);
    uint len = ids.length;
    for (uint i = 0; i < len; ++i) {
      _supply1155(token, ids[i], values[i]);
    }
    return this.onERC1155BatchReceived.selector;
  }

  /// @notice Sets required information when a 1155 token is received.
  /// @param from The address the token is coming from.
  /// @param ids The 1155 id to be added to the account.
  /// @param values The value to be added to the account.
  /// @return onERC1155Received if successful.
  function onERC1155Received(
    address,
    address from,
    uint256 id,
    uint256 value,
    bytes memory
  ) public override returns (bytes4) {
    address token = msg.sender;
    if (_not(tokenAllowed(token))) revert TokenDenied(token);
    if (_not(supplyAllowed(from))) revert SupplyDenied(from);
    _supply1155(token, id, value);
    return this.onERC1155Received.selector;
  }

  /*//////////////////////////////////////////////////////////////
                           OPEN FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Requests a lootbox openning paying with LINK.
  /// @param _opener The payer who wants to open a lootbox.
  /// @param _amount The max amount of LINK to pay.
  /// @param _gasAndLoot List of lootboxes to open and a gas limit for allocation
  ///                    ABI encoded as (uint32, uint[], uint[]), gas, ids, amounts.
  function onTokenTransfer(address _opener, uint _amount, bytes calldata _gasAndLoot) external override {
    if (msg.sender != address(LINK)) revert AcceptingOnlyLINK();
    (uint32 gas, uint[] memory lootIds, uint[] memory lootAmounts) =
      abi.decode(_gasAndLoot, (uint32, uint[], uint[]));
    uint vrfPrice = VRF_V2_WRAPPER.calculateRequestPrice(gas);
    if (_amount < vrfPrice) revert InsufficientPayment();
    _amount -= vrfPrice;
    uint unitsToGet = _requestOpen(_opener, gas, lootIds, lootAmounts);
    uint feePerUnit = FACTORY.feePerUnit(address(this));
    uint feeInLink = feePerUnit * unitsToGet * LINK_UNIT / _getLinkPrice();
    if (_amount < feeInLink) revert InsufficientFee();
    if (feeInLink > 0) {
      LINK.transferAndCall(address(FACTORY), feeInLink, '');
    }
    if (_amount > feeInLink) {
      IERC20(address(LINK)).safeTransfer(_opener, _amount - feeInLink);
    }
  }

  /// @notice Requests a lootbox openning paying with native currency.
  /// @param _gas Gas limit for allocation.
  /// @param _lootIds Lootbox ids to open.
  /// @param _lootAmounts Lootbox amounts to open.
  function open(uint32 _gas, uint[] calldata _lootIds, uint[] calldata _lootAmounts) external payable {
    uint vrfPrice = VRF_V2_WRAPPER.calculateRequestPrice(_gas);
    uint vrfPriceNative = vrfPrice * _getLinkPrice() / LINK_UNIT;
    if (msg.value < vrfPriceNative) revert InsufficientPayment();
    uint payment = msg.value - vrfPriceNative;
    address opener = _msgSender();
    uint unitsToGet = _requestOpen(opener, _gas, _lootIds, _lootAmounts);
    uint feePerUnit = FACTORY.feePerUnit(address(this));
    uint feeInNative = feePerUnit * unitsToGet;
    if (payment < feeInNative) revert InsufficientFee();
    if (feeInNative > 0) {
      payable(FACTORY).sendValue(feeInNative);
    }
    if (payment > feeInNative) {
      payable(opener).sendValue(payment - feeInNative);
    }
  }

  // TODO: allow partial claiming to avoid OOG.
  /// @notice Claims the rewards for the lootbox openning.
  /// @dev The user must have some rewards allocated.
  /// @param _opener The address of the user that has an allocation after opening.
  function claimRewards(address _opener) external whenNotPaused() {
    uint ids = allowedTokens.length();
    for (uint i = 0; i < ids; ++i) {
      address token = allowedTokens.at(i);
      RewardType rewardType = rewards[token].rewardType;
      if (rewardType == RewardType.ERC20) {
        uint amount = allocationInfo[_opener][token].amount[0];
        if (amount == 0) {
          continue;
        }
        allocationInfo[_opener][token].amount[0] = 0;
        allocated[token][0] = allocated[token][0] - amount;
        IERC20(token).safeTransfer(_opener, amount);
        emit RewardsClaimed(_opener, token, 0, 1);
      }
      else {
        uint tokenIds = allocationInfo[_opener][token].ids.length();
        if (tokenIds == 0) {
          continue;
        }
        for (uint j = tokenIds - 1; j >= 0; --j) {
          uint tokenId = allocationInfo[_opener][token].ids.at(j);
          allocationInfo[_opener][token].ids.remove(tokenId);
          if (rewardType == RewardType.ERC721) {
            IERC721(token).safeTransferFrom(address(this), _opener, tokenId);
            emit RewardsClaimed(_opener, token, tokenId, 1);
          } else if (rewardType == RewardType.ERC1155NFT) {
            IERC1155(token).safeTransferFrom(address(this), _opener, tokenId, 1, '');
            emit RewardsClaimed(_opener, token, tokenId, 1);
          } else {
            uint amount = allocationInfo[_opener][token].amount[tokenId];
            allocationInfo[_opener][token].amount[tokenId] = 0;
            allocated[token][tokenId] = allocated[token][tokenId] - amount;
            IERC1155(token).safeTransferFrom(address(this), _opener, tokenId, amount, '');
            emit RewardsClaimed(_opener, token, tokenId, amount);
          }
        }
      }
    }
  }

  /// @notice Used to recover lootboxes for an address.
  /// @param _opener The address that opened the boxes.
  function recoverBoxes(address _opener) external {
    uint requestId = openerRequests[_opener];
    if (requestId == 0) revert NothingToRecover();
    if (requests[requestId].unitsToGet > 0) revert PendingOpenRequest();
    uint[] memory ids = requests[requestId].lootIds;
    uint[] memory amounts = requests[requestId].lootAmounts;
    delete requests[requestId];
    delete openerRequests[_opener];
    _mintBatch(_opener, ids, amounts, '');
  }

  /*//////////////////////////////////////////////////////////////
                          GETTER FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  struct ExtraRewardInfo {
    uint id;
    uint units;
    uint amountPerUnit;
    uint balance;
  }

  struct RewardView {
    address rewardToken;
    RewardType rewardType;
    uint units;
    uint amountPerUnit;
    uint balance;
    ExtraRewardInfo[] extra;
  }

  /// @notice Gets lootbox types for the contract.
  /// @return uint Array of values if the token exists and is allowed.
  function getLootboxTypes() external view returns (uint[] memory) {
    return lootboxTypes.values();
  }

  /// @notice Gets allowed token values for the contract.
  /// @return address Array of token addresses if they exist and are allowed.
  function getAllowedTokens() external view returns (address[] memory) {
    return allowedTokens.values();
  }

  /// @notice Gets authorized suppliers for the contract.
  /// @return address Array of addresses if they exist and are allowed to supply.
  function getSuppliers() external view returns (address[] memory) {
    return suppliers.values();
  }

  /// @notice Gets allowed tokens for the contract.
  /// @param _token The token being allowed.
  /// @return bool True if the token if it exists and is allowed.
  function tokenAllowed(address _token) public view returns (bool) {
    return allowedTokens.contains(_token);
  }

  /// @notice Gets allowed supply address for the contract.
  /// @param _from The address of the supplier.
  /// @return bool True if the address of the supplier exists and is allowed.
  function supplyAllowed(address _from) public view returns (bool) {
    return suppliers.contains(_from);
  }

  /// @notice Calculates the opening price of lootboxes.
  /// @param _gas The gas of the request price.
  /// @param _units The units being calculated.
  /// @return uint The VRF price after calculation with units and fees.
  function calculateOpenPrice(uint32 _gas, uint _units) external view returns (uint) {
    uint vrfPrice = VRF_V2_WRAPPER.calculateRequestPrice(_gas);
    uint linkPrice = _getLinkPrice();
    uint vrfPriceNative = vrfPrice * linkPrice / LINK_UNIT;
    uint feePerUnit = FACTORY.feePerUnit(address(this));
    return vrfPriceNative + (_units * feePerUnit);
  }

  /// @notice Returns the tokens and amounts per unit of the lootbox.
  /// @return result The list of rewards available for getting.
  /// @return leftoversResult The list of rewards that are not configured or has insufficient supply.
  function getInventory() external view returns (RewardView[] memory result, RewardView[] memory leftoversResult) {
    uint tokens = inventory.length();
    result = new RewardView[](tokens);
    for (uint i = 0; i < tokens; ++i) {
      address token = inventory.at(i);
      result[i].rewardToken = token;
      RewardType rewardType = rewards[token].rewardType;
      result[i].rewardType = rewardType;
      result[i].units = units(rewards[token].rewardInfo);
      result[i].amountPerUnit = amountPerUnit(rewards[token].rewardInfo);
      if (rewardType == RewardType.ERC20) {
        result[i].balance = result[i].units * result[i].amountPerUnit;
      }
      uint ids = rewards[token].ids.length();
      result[i].extra = new ExtraRewardInfo[](ids);
      for (uint j = 0; j < ids; ++j) {
        uint id = rewards[token].ids.at(j);
        result[i].extra[j].id = id;
        if (rewardType == RewardType.ERC1155) {
          result[i].extra[j].units = units(rewards[token].extraInfo[id]);
          result[i].extra[j].amountPerUnit = amountPerUnit(rewards[token].extraInfo[id]);
          result[i].extra[j].balance = result[i].extra[j].units * result[i].extra[j].amountPerUnit;
        }
      }
    }

    tokens = allowedTokens.length();
    leftoversResult = new RewardView[](tokens);
    uint k = 0;
    for (uint i = 0; i < tokens; ++i) {
      address token = allowedTokens.at(i);
      leftoversResult[k].rewardToken = token;
      RewardType rewardType = rewards[token].rewardType;
      leftoversResult[k].rewardType = rewardType;
      leftoversResult[k].amountPerUnit = amountPerUnit(rewards[token].rewardInfo);
      if (rewardType == RewardType.ERC20 || rewardType == RewardType.UNSET) {
        leftoversResult[k].balance =
          tryBalanceOfThis(token) - allocated[token][0]
          - (units(rewards[token].rewardInfo) * leftoversResult[k].amountPerUnit);
        if (leftoversResult[k].balance > 0) {
          ++k;
        }
        continue;
      }
      if (rewardType == RewardType.ERC721 || rewardType == RewardType.ERC1155NFT) {
        if (inventory.contains(token)) {
          continue;
        }
        EnumerableSet.UintSet storage tokenIds = rewards[token].ids;
        uint ids = tokenIds.length();
        if (ids == 0) {
          continue;
        }
        leftoversResult[k].extra = new ExtraRewardInfo[](ids);
        for (uint j = 0; j < ids; ++j) {
          leftoversResult[k].extra[j].id = tokenIds.at(j);
        }
      } else {
        // Same as with ERC20, ERC1155 could have a particular asset ID simultaneously in the inventory and leftovers.
        // TODO: refactor code duplication.
        EnumerableSet.UintSet storage tokenIds = rewards[token].ids;
        EnumerableSet.UintSet storage leftoverTokenIds = leftoversExtraIds[token];
        ExtraRewardInfo[] memory extra = new ExtraRewardInfo[](tokenIds.length() + leftoverTokenIds.length());
        uint l = 0;
        for (uint j = 0; j < tokenIds.length(); ++j) {
          uint id = tokenIds.at(j);
          extra[l].id = id;
          extra[l].amountPerUnit = amountPerUnit(rewards[token].extraInfo[id]);
          extra[l].balance = IERC1155(token).balanceOf(address(this), id) - allocated[token][id]
            - (units(rewards[token].extraInfo[id]) * extra[l].amountPerUnit);
          if (extra[l].balance == 0) {
            continue;
          }
          ++l;
        }
        for (uint j = 0; j < leftoverTokenIds.length(); ++j) {
          uint id = leftoverTokenIds.at(j);
          extra[l].id = id;
          extra[l].amountPerUnit = amountPerUnit(rewards[token].extraInfo[id]);
          extra[l].balance = IERC1155(token).balanceOf(address(this), id) - allocated[token][id]
            - (units(rewards[token].extraInfo[id]) * extra[l].amountPerUnit);
          if (extra[l].balance == 0) {
            continue;
          }
          ++l;
        }
        if (l == 0) {
          continue;
        }
        // Shrink the leftovers extra array to its actual size.
        assembly {
          mstore(extra, l)
        }
        leftoversResult[k].extra = extra;
      }

      ++k;
    }
    // Shrink the leftovers array to its actual size.
    assembly {
      mstore(leftoversResult, k)
    }
    return (result, leftoversResult);
  }

  // TODO: Add a function to list user allocation.

  /// @notice Returns whether the rewards for the given opener can be claimed.
  /// @param _opener The address of the user that opened the lootbox.
  /// @return bool True if claim is possible, otherwise false.
  function canClaimRewards(address _opener) public view returns (bool) {
    uint ids = allowedTokens.length();
    for (uint i = 0; i < ids; ++i) {
      address token = allowedTokens.at(i);
      RewardType rewardType = rewards[token].rewardType;
      if (rewardType == RewardType.ERC20) {
        if (allocationInfo[_opener][token].amount[0] > 0) {
          return true;
        }
      } else {
        if (allocationInfo[_opener][token].ids.length() > 0) {
          return true;
        }
      }
    }
    return false;
  }

  /// @notice Gets the LINK token address.
  /// @return address The address of the LINK token.
  function getLink() external view returns (address) {
    return address(LINK);
  }

  /// @notice Gets the VRF wrapper for the contract.
  /// @return address The address of the VRF wrapper.
  function getVRFV2Wrapper() external view returns (address) {
    return address(VRF_V2_WRAPPER);
  }

  /*//////////////////////////////////////////////////////////////
                           OWNER FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Transfer the contract balance to the owner.
  function withdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
    payable(_msgSender()).sendValue(address(this).balance);
  }

  /*//////////////////////////////////////////////////////////////
                              VRF LOGIC
  //////////////////////////////////////////////////////////////*/

  /// @notice Requests randomness from Chainlink VRF.
  /// @dev The VRF subscription must be active and sufficient LINK must be available.
  /// @return requestId The ID of the request.
  function _requestRandomness(uint32 _gas) internal returns (uint256 requestId) {
    return requestRandomness(
      _gas,
      REQUEST_CONFIRMATIONS,
      NUMWORDS
    );
  }

  /// @inheritdoc VRFV2WrapperConsumerBase
  function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
    try this._allocateRewards{gas: gasleft() - 20000}(requestId, randomWords[0]) {
      emit OpenRequestFulfilled(requestId, randomWords[0]);
    } catch {
      requests[requestId].unitsToGet = 0;
      emit OpenRequestFailed(requestId);
    }
  }

  /*//////////////////////////////////////////////////////////////
                         INTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Removes an authorized supplier for the contract.
  /// @param _address The address being removed.
  function _removeSupplier(address _address) internal {
    if (suppliers.remove(_address)) {
      emit SupplierRemoved(_address);
    }
  }

  /// @notice Adds a supplier for the contract.
  /// @param _address The address being added.
  function _addSupplier(address _address) internal {
    if (suppliers.add(_address)) {
      emit SupplierAdded(_address);
    }
  }

  /// @notice Adds a supplier for the contract.
  /// @param _token The token address being added.
  function _addToken(address _token) internal {
    if (allowedTokens.add(_token)) {
      emit TokenAdded(_token);
    }
  }

  // TODO: Deal with the ERC721 sent through simple transferFrom, instead of safeTransferFrom.
  /// @notice Sets amount per unit.
  /// @param _currentSupply The current supply of units.
  /// @param _token The token being supplied.
  /// @param _id The id being used.
  /// @param _amountPerUnit The amount per unit.
  /// @return uint The new supply of units after calculation.
  function _setAmountPerUnit(uint _currentSupply, address _token, uint _id, uint _amountPerUnit) internal returns (uint) {
    if (_not(tokenAllowed(_token))) revert TokenDenied(_token);
    RewardInfo rewardInfo = rewards[_token].rewardInfo;
    RewardType rewardType = rewards[_token].rewardType;
    if (rewardType == RewardType.UNSET) {
      // Assuming ERC20.
      if (tryBalanceOfThis(_token) == 0) revert NoTokens();
      rewardType = RewardType.ERC20;
      rewards[_token].rewardType = rewardType;
    }

    uint unitsOld = units(rewardInfo);
    uint unitsNew;
    if (rewardType == RewardType.ERC20) {
      unitsNew = _amountPerUnit == 0 ? 0 : (IERC20(_token).balanceOf(address(this)) - allocated[_token][0]) / _amountPerUnit;
      rewardInfo = toInfo(unitsNew, _amountPerUnit);
    } else if (rewardType == RewardType.ERC721 || rewardType == RewardType.ERC1155NFT) {
      unitsNew = _amountPerUnit == 0 ? 0 : rewards[_token].ids.length() / _amountPerUnit;
      rewardInfo = toInfo(unitsNew, _amountPerUnit);
    } else if (rewardType == RewardType.ERC1155) {
      RewardInfo extraInfo = rewards[_token].extraInfo[_id];
      uint tokenUnitsOld = units(extraInfo);
      uint balance = IERC1155(_token).balanceOf(address(this), _id) - allocated[_token][_id];
      uint tokenUnitsNew = _amountPerUnit == 0 ? 0 : balance / _amountPerUnit;
      rewards[_token].extraInfo[_id] = toInfo(tokenUnitsNew, _amountPerUnit);
      unitsNew = unitsOld - tokenUnitsOld + tokenUnitsNew;
      rewardInfo = toInfo(unitsNew, amountPerUnit(rewardInfo));
      if (tokenUnitsNew > 0) {
        leftoversExtraIds[_token].remove(_id); // TODO: Refactor into the same logic as with allowed tokens. There should be a list of 1155 ids which are present in the inventory or not.
        rewards[_token].ids.add(_id);
      } else {
        rewards[_token].ids.remove(_id);
        leftoversExtraIds[_token].add(_id);
      }
    }
    uint newSupply = _currentSupply - unitsOld + unitsNew;
    rewards[_token].rewardInfo = rewardInfo;
    if (unitsNew > 0) {
      inventory.add(_token);
    } else {
      inventory.remove(_token);
    }

    emit AmountPerUnitSet(_token, _id, _amountPerUnit, newSupply);
    return newSupply;
  }

  /// @notice Gets LINK price.
  /// @return uint The link price from wei converted to uint.
  function _getLinkPrice() internal view returns (uint) {
    int256 weiPerUnitLink;
    (, weiPerUnitLink, , , ) = LINK_ETH_FEED.latestRoundData();
    if (weiPerUnitLink <= 0) revert InvalidLinkPrice(weiPerUnitLink);
    return uint(weiPerUnitLink);
  }

  /// @notice Gets 1155 supply.
  /// @param token The token address.
  /// @param id The token id.
  /// @param value The token value.
  function _supply1155(address token, uint id, uint value) internal {
    if (value == 0) revert ZeroSupply(token, id);
    RewardInfo rewardInfo = rewards[token].rewardInfo;
    RewardType rewardType = rewards[token].rewardType;
    bool isFirstTime = rewardType == RewardType.UNSET;
    if (isFirstTime) {
      if (value == 1) {
        // If the value is 1, then we assume token to be distributed as NFT.
        rewardInfo = toInfo(0, 1);
        rewards[token].rewardInfo = rewardInfo;
        rewardType = RewardType.ERC1155NFT;
      } else {
        rewardType = RewardType.ERC1155;
      }
      rewards[token].rewardType = rewardType;
    } else if (rewardType != RewardType.ERC1155 && rewardType != RewardType.ERC1155NFT) {
      revert ModifiedRewardType(rewards[token].rewardType, RewardType.ERC1155);
    }
    if (rewardType == RewardType.ERC1155) {
      _supply1155(rewardInfo, token, id, value);
    } else {
      if (value > 1) revert InvalidTokenAmount();
      _supplyNFT(rewardInfo, token, id);
    }
  }

  /// @notice Gets 1155 supply with reward information.
  /// @param rewardInfo The reward information.
  /// @param token The token address.
  /// @param id The token id.
  /// @param value The token value.
  function _supply1155(RewardInfo rewardInfo, address token, uint id, uint value) internal {
    RewardInfo extraInfo = rewards[token].extraInfo[id];
    bool isNotConfigured = isEmpty(extraInfo);
    uint unitsOld = units(extraInfo);
    uint unitsNew = unitsOld + (isNotConfigured ? 0 : (value / amountPerUnit(extraInfo)));
    uint unitsAdded = unitsNew - unitsOld;
    if (unitsAdded > 0) {
      unitsSupply = unitsSupply + unitsAdded;
      rewards[token].extraInfo[id] = toInfo(unitsNew, amountPerUnit(extraInfo));
      if (unitsOld == 0) {
        if (_not(rewards[token].ids.add(id))) revert DepositStateCorruption(token, id);
        leftoversExtraIds[token].remove(id);
      }
      uint tokenUnitsOld = units(rewardInfo);
      rewards[token].rewardInfo = toInfo(tokenUnitsOld + unitsAdded, amountPerUnit(rewardInfo));
      if (tokenUnitsOld == 0) {
        if (_not(inventory.add(token))) revert InventoryStateCorruption(token);
      }
    } else if (unitsOld == 0) {
      leftoversExtraIds[token].add(id);
    }
  }

  /// @notice Supplies NFT with reward information.
  /// @param rewardInfo The reward information.
  /// @param token The token address.
  /// @param id The token id.
  function _supplyNFT(RewardInfo rewardInfo, address token, uint id) internal {
    if (_not(rewards[token].ids.add(id))) revert DepositStateCorruption(token, id);
    uint perUnit = amountPerUnit(rewardInfo);
    uint unitsOld = units(rewardInfo);
    uint unitsNew = perUnit == 0 ? 0 : (rewards[token].ids.length() / perUnit);
    uint unitsAdded = unitsNew - unitsOld;
    if (unitsAdded > 0) {
      rewards[token].rewardInfo = toInfo(unitsNew, perUnit);
      unitsSupply = unitsSupply + unitsAdded;
      if (unitsOld == 0) {
        if (_not(inventory.add(token))) revert InventoryStateCorruption(token);
      }
    }
  }

  /// @dev Requests randomness from Chainlink VRF and stores the request data for later use.
  /// @notice Creates a lootbox open request for the given loot.
  /// @param _opener The address requesting to open the lootbox.
  /// @param _gas The gas amount.
  /// @param _lootIds An array of loot ids.
  /// @param _lootAmounts An array of loot amounts.
  /// @return uint The units.
  function _requestOpen(
    address _opener,
    uint32 _gas,
    uint[] memory _lootIds,
    uint[] memory _lootAmounts
  ) internal returns (uint) {
    if (openerRequests[_opener] != 0) revert PendingOpenRequest();
    if (_gas < 100000) revert InsufficientGas();
    _burnBatch(_opener, _lootIds, _lootAmounts);
    uint unitsToGet = 0;
    uint ids = _lootIds.length;
    for (uint i = 0; i < ids; ++i) {
      unitsToGet += _lootIds[i] * _lootAmounts[i];
    }
    if (unitsToGet == 0) revert ZeroAmount();
    if (unitsSupply < unitsToGet) revert SupplyExceeded(unitsSupply, unitsToGet);

    uint256 requestId = _requestRandomness(_gas);

    requests[requestId] = Request({
      opener: _opener,
      unitsToGet: unitsToGet.toUint96(),
      lootIds: _lootIds,
      lootAmounts: _lootAmounts
    });

    openerRequests[_opener] = requestId;

    emit OpenRequested(_opener, unitsToGet, requestId);

    return unitsToGet;
  }

  /// @notice Picks the rewards using the given randomness as a seed.
  /// @param _requestId The amount of lootbox units the user is opening.
  /// @param _randomness The random number used to pick the rewards.
  function _allocateRewards(
    uint256 _requestId,
    uint256 _randomness
  ) external {
    if (msg.sender != address(this)) revert OnlyThis();
    mapping(address => Lootbox.AllocationInfo) storage openerAllocation =
      allocationInfo[requests[_requestId].opener];
    uint unitsToGet = requests[_requestId].unitsToGet;
    if (unitsToGet == 0) revert InvalidRequestAllocation(_requestId);
    delete requests[_requestId];
    delete openerRequests[requests[_requestId].opener];
    uint256 totalUnits = unitsSupply;
    unitsSupply = totalUnits - unitsToGet;

    for (; unitsToGet > 0; --unitsToGet) {
      uint256 target = uint256(keccak256(abi.encodePacked(_randomness, unitsToGet))) % totalUnits;
      uint256 offset = 0;

      for (uint256 j = 0;; ++j) {
        address token = inventory.at(j);
        RewardType rewardType = rewards[token].rewardType;
        RewardInfo rewardInfo = rewards[token].rewardInfo;
        uint256 unitsOfToken = units(rewardInfo);

        if (target < offset + unitsOfToken) {
          --totalUnits;
          uint amount = amountPerUnit(rewardInfo);
          rewardInfo = toInfo(unitsOfToken - 1, amount);
          rewards[token].rewardInfo = rewardInfo;
          if (units(rewardInfo) == 0) {
            inventory.remove(token);
          }
          if (rewardType == RewardType.ERC20) {
            openerAllocation[token].amount[0] += amount;
            allocated[token][0] += amount;
          }
          else if (rewardType == RewardType.ERC721 || rewardType == RewardType.ERC1155NFT) {
            uint ids = rewards[token].ids.length();
            for (uint k = 0; k < amount; ++k) {
              target = uint256(keccak256(abi.encodePacked(_randomness, unitsToGet, k))) % ids;
              uint tokenId = rewards[token].ids.at(target);
              rewards[token].ids.remove(tokenId);
              --ids;
              openerAllocation[token].ids.add(tokenId);
            }
          }
          else if (rewardType == RewardType.ERC1155) {
            // Reusing variables before inevitable break of the loop.
            target = target - offset;
            offset = 0;
            for (uint k = 0;; ++k) {
              uint id = rewards[token].ids.at(k);
              RewardInfo extraInfo = rewards[token].extraInfo[id];
              unitsOfToken = units(extraInfo);
              if (target < offset + unitsOfToken) {
                amount = amountPerUnit(extraInfo);
                extraInfo = toInfo(unitsOfToken - 1, amount);
                rewards[token].extraInfo[id] = extraInfo;
                openerAllocation[token].ids.add(id);
                openerAllocation[token].amount[id] += amount;
                allocated[token][id] += amount;
                if (units(extraInfo) == 0) {
                  rewards[token].ids.remove(id);
                  if (IERC1155(token).balanceOf(address(this), id) - allocated[token][id] > 0) {
                    leftoversExtraIds[token].add(id);
                  }
                }
                break;
              }

              offset += unitsOfToken;
            }
          }
          else {
            revert UnexpectedRewardType(rewardType);
          }

          break;
        }

        offset += unitsOfToken;
      }
    }
  }

  /// @notice Checks the balance of an erc20 token.
  /// @param _token The token being checked.
  /// @return uint erc20 token balance, else 0 if not an erc20 token.
  function tryBalanceOfThis(address _token) internal view returns (uint) {
    try IERC20(_token).balanceOf(address(this)) returns(uint result) {
      return result;
    } catch {
      // not an ERC20 so has to transfer first.
      return 0;
    }
  }

  /// @notice Checks units by by reward information.
  /// @param _rewardInfo The reward information.
  /// @return RewardInfo Reward information as uint.
  function units(RewardInfo _rewardInfo) internal pure returns (uint) {
    return RewardInfo.unwrap(_rewardInfo) >> UNITS_OFFSET;
  }

  /// @notice Checks amount per unity by reward information.
  /// @param _rewardInfo The reward information.
  /// @return RewardInfo Reward information as uint.
  function amountPerUnit(RewardInfo _rewardInfo) internal pure returns (uint) {
    return uint184(RewardInfo.unwrap(_rewardInfo));
  }

  /// @notice Checks amount per unity by reward information.
  /// @param _units The reward information.
  /// @param _amountPerUnit The amount per unit.
  /// @return RewardInfo Reward information or amounts per unit.
  function toInfo(uint _units, uint _amountPerUnit) internal pure returns (RewardInfo) {
    if (_units > type(uint64).max) revert UnitsOverflow(_units);
    if (_amountPerUnit > type(uint184).max) revert AmountPerUnitOverflow(_amountPerUnit);
    return RewardInfo.wrap(uint248((_units << UNITS_OFFSET) | _amountPerUnit));
  }

  /// @notice Checks if reward information is empty.
  /// @param _rewardInfo The reaward information.
  /// @return RewardInfo Empty reward information.
  function isEmpty(RewardInfo _rewardInfo) internal pure returns (bool) {
    return RewardInfo.unwrap(_rewardInfo) == 0;
  }

  /// @notice Returns value bool.
  /// @param _value Boolean value.
  /// @return bool Opposite bool value.
  function _not(bool _value) internal pure returns (bool) {
    return !_value;
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId)
    public
    view
    virtual
    override(ERC1155Receiver, ERC1155PresetMinterPauser)
    returns (bool)
  {
    return ERC1155Receiver.supportsInterface(interfaceId) ||
      ERC1155PresetMinterPauser.supportsInterface(interfaceId);
  }

  /// @notice Fires before token transfer.
  /// @param operator Boolean value.
  /// @param from From address.
  /// @param to To address.
  /// @param ids Id array.
  /// @param amounts Amounts array.
  /// @param data Data in bytes.
  function _beforeTokenTransfer(
    address operator,
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory amounts,
    bytes memory data
  ) internal virtual override(ERC1155PresetMinterPauser) {
    if (from == address(0)) {
      uint len = ids.length;
      for (uint i = 0; i < len; ++i) {
        uint id = ids[i];
        if (id == 0 || id > type(uint8).max) revert InvalidLootboxType();
        lootboxTypes.add(id);
      }
    }
    super._beforeTokenTransfer(operator, from, to, ids, amounts, data);
  }
}
