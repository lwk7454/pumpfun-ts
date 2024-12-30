import { ParsedTransactionWithMeta } from '@solana/web3.js';

export const txnBuy: ParsedTransactionWithMeta = {
  blockTime: 1735470595,
  meta: {
    computeUnitsConsumed: 90291,
    err: null,
    fee: 15000,
    innerInstructions: [
      {
        index: 2,
        instructions: []
      },
      {
        index: 3,
        instructions: []
      }
    ],
    logMessages: [],
    postBalances: [
      135478286, 2039280,
      253734243170659, 2868537660,
      2039280, 4130464482,
      1, 731913600,
      1461600, 1,
      934087680, 1398960,
      246641999, 1009200,
      112000014, 1141440
    ],
    postTokenBalances: [
      {
        accountIndex: 1,
        mint: "Awt4iFZ6EKHgrvuQybKiwdENoLeAZYSo9wbXHCowWDFY",
        owner: "41A8cAh6VJGGoDkJbK1wecpSZ13tkRcjEBWRSUW4s6iU",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "29799294421",
          decimals: 6,
          uiAmount: 29799.294421,
          uiAmountString: "29799.294421"
        }
      },
      {
        accountIndex: 4,
        mint: "Awt4iFZ6EKHgrvuQybKiwdENoLeAZYSo9wbXHCowWDFY",
        owner: "GfDT3BYjMFQvML3stTtFmgXT1p3R53o6bczHdidpfrbd",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "906392721134526",
          decimals: 6,
          uiAmount: 906392721.134526,
          uiAmountString: "906392721.134526"
        }
      }
    ],
    preBalances: [
      138547566, 0,
      253734243160659, 2867537659,
      2039280, 4130459483,
      1, 731913600,
      1461600, 1,
      934087680, 1398960,
      246641999, 1009200,
      112000014, 1141440
    ],
    preTokenBalances: [
      {
        accountIndex: 4,
        mint: "Awt4iFZ6EKHgrvuQybKiwdENoLeAZYSo9wbXHCowWDFY",
        owner: "GfDT3BYjMFQvML3stTtFmgXT1p3R53o6bczHdidpfrbd",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: {
          amount: "906422520428947",
          decimals: 6,
          uiAmount: 906422520.428947,
          uiAmountString: "906422520.428947"
        }
      }
    ],
  },
  slot: 310547013,
  transaction: {
    message: {
      accountKeys: [],
      addressTableLookups: [],
      instructions: [],
      recentBlockhash: "5HPmckZknCoHcXvREJaV6cMeCZQZbAPbcdgvRgasDiTA"
    },
    signatures: [
      "627CapMXWFRScSBoquu1qc2w9E9kZhasSEsxQzRtQcSXwB6jWRd82fQStVu7NnNiNxXyn73qoM7GzNXQvG8tjLEH"
    ]
  },
  version: 0
}