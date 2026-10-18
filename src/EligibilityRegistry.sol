// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Onchain eligibility allowlist (non-US-person attestation, set by our attester).
/// eligibleUntil[account] = unix expiry; 0 or past = not eligible.
contract EligibilityRegistry is AccessControl {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    mapping(address account => uint64) public eligibleUntil;

    event EligibilitySet(address indexed account, uint64 expiry);

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

    function isEligible(address account) public view returns (bool) {
        return eligibleUntil[account] > block.timestamp;
    }
}
