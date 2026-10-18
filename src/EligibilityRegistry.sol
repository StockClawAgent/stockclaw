// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IOwned {
    function owner() external view returns (address);
}

/// @notice Onchain eligibility allowlist, keyed to the OWNER EOA that signed the non-US-person
/// attestation (set by our attester; eligibleUntil = unix expiry).
/// Smart accounts (AgentVaults) inherit their owner's eligibility: the eligible owner links the
/// account (`linkAccount`), and at check time the account's current `owner()` must still equal the
/// linked owner and that owner must still be eligible. Ownership transfer or owner expiry => ineligible.
contract EligibilityRegistry is AccessControl {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    mapping(address account => uint64) public eligibleUntil;
    mapping(address account => address owner) public linkedOwner;

    event EligibilitySet(address indexed account, uint64 expiry);
    event AccountLinked(address indexed account, address indexed owner);

    error NotAccountOwner();
    error OwnerNotEligible();

    constructor(address admin, address attester) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, attester);
    }

    function setEligible(address account, uint64 expiry) external onlyRole(ATTESTER_ROLE) {
        eligibleUntil[account] = expiry;
        emit EligibilitySet(account, expiry);
    }

    function setEligibleBatch(address[] calldata accounts, uint64 expiry) external onlyRole(ATTESTER_ROLE) {
        for (uint256 i; i < accounts.length; ++i) {
            eligibleUntil[accounts[i]] = expiry;
            emit EligibilitySet(accounts[i], expiry);
        }
    }

    function revoke(address account) external onlyRole(ATTESTER_ROLE) {
        eligibleUntil[account] = 0;
        emit EligibilitySet(account, 0);
    }

    /// @notice Called by an eligible owner EOA to let a smart account it owns inherit eligibility.
    function linkAccount(address account) external {
        if (eligibleUntil[msg.sender] <= block.timestamp) revert OwnerNotEligible();
        if (IOwned(account).owner() != msg.sender) revert NotAccountOwner();
        linkedOwner[account] = msg.sender;
        emit AccountLinked(account, msg.sender);
    }

    function isEligible(address account) public view returns (bool) {
        if (eligibleUntil[account] > block.timestamp) return true;
        address o = linkedOwner[account];
        if (o == address(0) || eligibleUntil[o] <= block.timestamp) return false;
        try IOwned(account).owner() returns (address cur) {
            return cur == o;
        } catch {
            return false;
        }
    }
}
