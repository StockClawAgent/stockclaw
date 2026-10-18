// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";

/// @notice Simplified Permit2 SignatureTransfer for unit tests (NOT the real EIP-712 encoding).
/// Signs keccak256(token, amount, nonce, deadline, spender) as an eth_sign message. TEST ONLY.
/// Testnet integration tests should use the canonical Permit2 at 0x000000000022D473030F116dDEE9F6B43aC78BA3.
contract MockPermit2 is ISignatureTransfer {
    using SafeERC20 for IERC20;

    mapping(address => mapping(uint256 => bool)) public usedNonce;

    error InvalidSigner();
    error NonceUsed();
    error SignatureExpired();
    error TooMuch();

    function digest(PermitTransferFrom calldata p, address spender) public pure returns (bytes32) {
        return keccak256(abi.encode(p.permitted.token, p.permitted.amount, p.nonce, p.deadline, spender));
    }

    function permitTransferFrom(
        PermitTransferFrom calldata p,
        SignatureTransferDetails calldata d,
        address owner,
        bytes calldata sig
    ) external {
        if (block.timestamp > p.deadline) revert SignatureExpired();
        if (d.requestedAmount > p.permitted.amount) revert TooMuch();
        if (usedNonce[owner][p.nonce]) revert NonceUsed();
        if (ECDSA.recover(digest(p, msg.sender), sig) != owner) revert InvalidSigner();
        usedNonce[owner][p.nonce] = true;
        IERC20(p.permitted.token).safeTransferFrom(owner, d.to, d.requestedAmount);
    }
}
