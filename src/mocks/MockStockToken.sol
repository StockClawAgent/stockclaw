// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mimics an issuer-controlled stock token: global pause, per-account freeze, and a
/// transfer registry (KYC allowlist) that can be toggled on. TEST ONLY.
contract MockStockToken is ERC20 {
    address public issuer;
    bool public paused;
    bool public registryEnforced;
    mapping(address => bool) public isFrozen;
    mapping(address => bool) public registered;

    error Paused();
    error Frozen(address account);
    error NotRegistered(address account);
    error OnlyIssuer();

    constructor(string memory n, string memory s) ERC20(n, s) {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    function mint(address to, uint256 amt) external onlyIssuer {
        _mint(to, amt);
    }

    function setPaused(bool v) external onlyIssuer {
        paused = v;
    }

    function setFrozen(address a, bool v) external onlyIssuer {
        isFrozen[a] = v;
    }

    function setRegistered(address a, bool v) external onlyIssuer {
        registered[a] = v;
    }

    function setRegistryEnforced(bool v) external onlyIssuer {
        registryEnforced = v;
    }

    function canTransfer(address from, address to, uint256) public view returns (bool) {
        if (paused || isFrozen[from] || isFrozen[to]) return false;
        if (registryEnforced && (!registered[from] || !registered[to])) return false;
        return true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (paused) revert Paused();
            if (isFrozen[from]) revert Frozen(from);
            if (isFrozen[to]) revert Frozen(to);
            if (registryEnforced) {
                if (!registered[from]) revert NotRegistered(from);
                if (!registered[to]) revert NotRegistered(to);
            }
        }
        super._update(from, to, value);
    }
}
