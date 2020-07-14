import { Field, F, Point } from '@zkopru/babyjubjub'
import { txSizeCalculator, logger } from '@zkopru/utils'
import { fromWei } from 'web3-utils'
import assert from 'assert'
import { Utxo } from './utxo'
import { Sum } from './note-sum'
import { Outflow } from './outflow'
import { Withdrawal } from './withdrawal'
import { Migration } from './migration'
import { OutflowType } from './note'
import { RawTx } from './raw-tx'

export class TxBuilder {
  spendables: Utxo[]

  sendings: Outflow[]

  feePerByte: Field

  swap?: Field

  changeTo: Point

  constructor(pubKey: Point) {
    this.spendables = []
    this.sendings = []
    this.changeTo = pubKey
    this.feePerByte = Field.zero
  }

  static from(pubKey: Point): TxBuilder {
    return new TxBuilder(pubKey)
  }

  weiPerByte(val: F): TxBuilder {
    this.feePerByte = Field.from(val)
    return this
  }

  provide(...utxos: Utxo[]): TxBuilder {
    utxos.forEach(utxo => this.spendables.push(utxo))
    return this
  }

  /**
   * This will throw underflow Error when it does not have enough ETH for fee
   */
  spendable(): Sum {
    const asset = Sum.from(this.spendables)
    // asset.eth = asset.eth.sub(this.weiPerByte)
    return asset
  }

  sendEther({
    eth,
    to,
    withdrawal,
    migration,
  }: {
    eth: F
    to: Point
    withdrawal?: {
      to: F
      fee: F
    }
    migration?: {
      to: F
      fee: F
    }
  }): TxBuilder {
    if (withdrawal && migration)
      throw Error(
        'You should have only one value of withdrawalTo or migrationTo',
      )
    const note = Utxo.newEtherNote({ eth, pubKey: to })
    this.send(note, withdrawal, migration)
    return this
  }

  sendERC20({
    tokenAddr,
    erc20Amount,
    to,
    eth,
    withdrawal,
    migration,
  }: {
    tokenAddr: F
    erc20Amount: F
    to: Point
    eth?: F
    withdrawal?: {
      to: F
      fee: F
    }
    migration?: {
      to: F
      fee: F
    }
  }): TxBuilder {
    const note = Utxo.newERC20Note({
      eth: eth || 0,
      tokenAddr,
      erc20Amount,
      pubKey: to,
    })
    this.send(note, withdrawal, migration)
    return this
  }

  sendNFT({
    tokenAddr,
    nft,
    to,
    eth,
    withdrawal,
    migration,
  }: {
    tokenAddr: F
    nft: F
    to: Point
    eth?: F
    withdrawal?: {
      to: F
      fee: F
    }
    migration?: {
      to: F
      fee: F
    }
  }): TxBuilder {
    const note = Utxo.newNFTNote({
      eth: eth || 0,
      tokenAddr,
      nft,
      pubKey: to,
    })
    this.send(note, withdrawal, migration)
    return this
  }

  build(): RawTx {
    const spendables: Utxo[] = [...this.spendables]
    const spendings: Utxo[] = []
    const sendingAmount = Sum.from(this.sendings)
    const outgoingNotes: (Withdrawal | Migration)[] = this.sendings.filter(
      sending => sending instanceof Withdrawal || sending instanceof Migration,
    ) as (Withdrawal | Migration)[]
    const l1Fee = outgoingNotes.reduce(
      (acc, note) => acc.add(note.publicData.fee),
      Field.zero,
    )

    // Find ERC20 notes to spend
    Object.keys(sendingAmount.erc20).forEach(addr => {
      const targetAmount: Field = sendingAmount.erc20[addr]
      const sameERC20UTXOs: Utxo[] = this.spendables
        .filter(utxo => utxo.tokenAddr.toHex() === addr)
        .sort((a, b) => (a.erc20Amount.gt(b.erc20Amount) ? 1 : -1))
      for (const utxo of sameERC20UTXOs) {
        if (targetAmount.gt(Sum.from(spendings).erc20[addr])) {
          spendings.push(...spendables.splice(spendables.indexOf(utxo), 1))
        } else {
          break
        }
      }
      if (targetAmount.gt(Sum.from(spendings).erc20[addr])) {
        throw Error(`Not enough ERC20 token ${addr} / ${targetAmount}`)
      }
    })

    // Find ERC721 notes to spend
    Object.keys(sendingAmount.erc721).forEach(addr => {
      const sendingNFTs: Field[] = sendingAmount.erc721[addr].sort((a, b) =>
        a.gt(b) ? 1 : -1,
      )
      const spendingNFTNotes: Utxo[] = this.spendables.filter(utxo => {
        return (
          utxo.tokenAddr.toHex() === addr &&
          sendingNFTs.find(nft => nft.eq(utxo.nft)) !== undefined
        )
      })
      if (sendingNFTs.length !== spendingNFTNotes.length) {
        throw Error('Not enough NFTs')
      }
      spendingNFTNotes.sort((a, b) => (a.nft.gt(b.nft) ? 1 : -1))
      for (let i = 0; i < sendingNFTs.length; i += 1) {
        if (!sendingNFTs[i].eq(spendingNFTNotes[i].nft))
          throw Error('Failed to find the exact NFT')
      }
      for (const utxo of spendingNFTNotes) {
        spendings.push(...spendables.splice(spendables.indexOf(utxo), 1))
      }
    })

    const changes: Utxo[] = []
    // Start to calculate ERC20 changes
    const spendingAmount = () => Sum.from(spendings)
    Object.keys(spendingAmount().erc20).forEach(addr => {
      const change = spendingAmount().erc20[addr].sub(sendingAmount.erc20[addr])
      if (!change.isZero()) {
        changes.push(
          Utxo.newERC20Note({
            eth: 0,
            tokenAddr: Field.from(addr),
            erc20Amount: change,
            pubKey: this.changeTo,
          }),
        )
      }
    })
    // Start to calculate ERC721 changes
    const extraNFTs: { [addr: string]: Field[] } = {}
    Object.keys(spendingAmount().erc721).forEach(addr => {
      extraNFTs[addr] = spendingAmount().erc721[addr].filter(nft => {
        if (sendingAmount.erc721[addr] === undefined) {
          return true
        }
        if (sendingAmount.erc721[addr].find(nft.eq) === undefined) {
          return true
        }
        return false
      })
    })
    Object.keys(extraNFTs).forEach(addr => {
      extraNFTs[addr].forEach(nft => {
        changes.push(
          Utxo.newNFTNote({
            eth: 0,
            tokenAddr: Field.from(addr),
            nft,
            pubKey: this.changeTo,
          }),
        )
      })
    })

    // Start to check how many ETH this tx requires
    const getTxFee = (): Field => {
      const size = txSizeCalculator(
        spendings.length,
        this.sendings.length + changes.length + 1, // 1 is for Ether change note
        this.sendings.filter(note => note.outflowType !== OutflowType.UTXO)
          .length,
        !!this.swap,
        false,
      )
      return this.feePerByte.muln(size)
    }

    const getRequiredETH = (): Field => {
      return sendingAmount.eth.add(getTxFee()).add(l1Fee)
    }

    // Spend ETH containing notes until it hits the number
    spendables.sort((a, b) => (a.eth.gt(b.eth) ? -1 : 1))
    while (getRequiredETH().gte(Sum.from(spendings).eth)) {
      logger.info(`required eth: ${getRequiredETH().toString()}`)
      logger.info(`spending eth: ${Sum.from(spendings).eth}`)
      const spending = spendables.pop()
      logger.info(`spending: ${spendings.toString()}`)
      if (spending === undefined) {
        const owned = Sum.from(spendings).eth
        const target = getRequiredETH()
        const insufficient = target.sub(owned)
        throw Error(
          `Not enough Ether. Insufficient: ${fromWei(
            insufficient.toString(),
            'ether',
          )}`,
        )
      }
      spendings.push(spending)
    }

    // Calculate ETH change
    assert(spendingAmount().eth.gte(getRequiredETH()), 'not enough eth')
    const changeETH = spendingAmount().eth.sub(getRequiredETH())
    const finalFee = getTxFee()
    if (!changeETH.isZero()) {
      changes.push(Utxo.newEtherNote({ eth: changeETH, pubKey: this.changeTo }))
    }

    const inflow = [...spendings]
    const outflow = [...this.sendings, ...changes]
    const inflowSum = Sum.from(inflow)
    const outflowSum = Sum.from(outflow)
    assert(
      inflowSum.eth.eq(outflowSum.eth.add(finalFee).add(l1Fee)),
      'inflow != outflow',
    )
    for (const addr of Object.keys(inflowSum.erc20)) {
      assert(
        inflowSum.erc20[addr].eq(outflowSum.erc20[addr]),
        'erc20 in-out is different',
      )
    }
    for (const addr of Object.keys(inflowSum.erc721)) {
      const inflowNFTs = JSON.stringify(
        inflowSum.erc721[addr].map(f => f.toString()),
      )
      const outflowNFTs = JSON.stringify(
        outflowSum.erc721[addr].map(f => f.toString()),
      )
      assert(inflowNFTs === outflowNFTs, 'nft in-out is different')
    }
    return {
      inflow,
      outflow,
      swap: this.swap,
      fee: finalFee,
    }
  }

  protected send(
    note: Outflow,
    withdrawal?: {
      to: F
      fee: F
    },
    migration?: {
      to: F
      fee: F
    },
  ) {
    if (withdrawal) {
      this.sendings.push(Withdrawal.from(note, withdrawal.to, withdrawal.fee))
    } else if (migration) {
      this.sendings.push(Migration.from(note, migration.to, migration.fee))
    } else {
      this.sendings.push(note)
    }
  }
}