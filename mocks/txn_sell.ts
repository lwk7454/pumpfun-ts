import { ParsedTransactionWithMeta } from '@solana/web3.js';

export const txnSell: ParsedTransactionWithMeta = {
  blockTime: 1735471049,
  meta: {
    computeUnitsConsumed: 76970,
    err: null,
    fee: 6000,
    innerInstructions: [
      {
        index: 3,
        instructions: []
      }
    ],
    logMessages: [],
    postBalances: [
      178718277, 0,
      253770874898663, 4230494632,
      2039280, 4180575622,
      1, 731913600,
      1461600, 1,
      934087680, 1398960,
      246641999, 112000014,
      1141440
    ],
    postTokenBalances: [
      {
        accountIndex: 4,
        mint: "FbGqkdq6ENfs7Sm5KLvgTeh5cs4i9k6Pn7dNxeVDpump",
        owner: "EBuXpdEyVzRVAXyq1NMmNPNhsEjnyFkjM5pt75mgNXAg",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "867423414037715",
          decimals: 6,
          uiAmount: 867423414.037715,
          uiAmountString: "867423414.037715"
        }
      }
    ],
    preBalances: [
      175645463, 2039280,
      253770874888110, 4231549995,
      2039280, 4180570346,
      1, 731913600,
      1461600, 1,
      934087680, 1398960,
      246641999, 112000014,
      1141440
    ],
    preTokenBalances: [
      {
        accountIndex: 1,
        mint: "FbGqkdq6ENfs7Sm5KLvgTeh5cs4i9k6Pn7dNxeVDpump",
        owner: "41A8cAh6VJGGoDkJbK1wecpSZ13tkRcjEBWRSUW4s6iU",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "28994417101",
          decimals: 6,
          uiAmount: 28994.417101,
          uiAmountString: "28994.417101"
        }
      },
      {
        accountIndex: 4,
        mint: "FbGqkdq6ENfs7Sm5KLvgTeh5cs4i9k6Pn7dNxeVDpump",
        owner: "EBuXpdEyVzRVAXyq1NMmNPNhsEjnyFkjM5pt75mgNXAg",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "867394419620614",
          decimals: 6,
          uiAmount: 867394419.620614,
          uiAmountString: "867394419.620614"
        }
      }
    ],
  },
  slot: 310548127,
  transaction: {
    message: {
      instructions: [],
      accountKeys: [],
      recentBlockhash: "BJws7o3AFJQ5ru4PetPpQmo1TYnJW4Dv2vyBbnqzhNiE"
    },
    signatures: [
      "xEaebjXg2PMrBkNfkM3CdQvgHfoWUutoD2WzDcTpWq8AHJPt5VmKt2ahp5hviAruQEn6EC2E9mYX88Q4QkTQNjs"
    ]
  },
  version: 0
}