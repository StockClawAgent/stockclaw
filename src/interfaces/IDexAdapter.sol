// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pluggable DEX adapter. The FeeRouter transfers `amountIn` of `tokenIn` to the
/// adapter BEFORE calling `swap`; the adapter must deliver >= `minOut` of `tokenOut` to `recipient`.
interface IDexAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);

    /// @notice True iff this adapter can swap tokenIn -> tokenOut (cheap pair check, N-4).
    function supportsPair(address tokenIn, address tokenOut) external view returns (bool);

    /// @notice Spot/indicative quote. NOT manipulation-resistant by itself; see ARCHITECTURE.md.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
}
