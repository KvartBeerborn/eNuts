import Loading from '@comps/Loading'
import Txt from '@comps/Txt'
import { getMintBalance } from '@db'
import type { IMintUrl } from '@model'
import type { TBeforeRemoveEvent, TProcessingPageProps } from '@model/nav'
import { preventBack } from '@nav/utils'
import { pool } from '@nostr/class/Pool'
import { getNostrUsername } from '@nostr/util'
import { useNostrContext } from '@src/context/Nostr'
import { useThemeContext } from '@src/context/Theme'
import { NS } from '@src/i18n'
import { addLnPaymentToHistory } from '@store/HistoryStore'
import { addToHistory, updateLatestHistory } from '@store/latestHistoryEntries'
import { getDefaultMint } from '@store/mintStore'
import { globals } from '@styles'
import { decodeLnInvoice, getInvoiceFromLnurl, isErr, isLnurl, uniqByIContacts } from '@util'
import { autoMintSwap, checkFees, getHighestBalMint, payLnInvoice, requestMint, sendToken } from '@wallet'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet, View } from 'react-native'

interface IErrorProps {
	e?: unknown
	customMsg?: 'requestMintErr' | 'generalMeltingErr' | 'invoiceFromLnurlError'
}

export default function ProcessingScreen({ navigation, route }: TProcessingPageProps) {
	const { t } = useTranslation([NS.mints])
	const { color } = useThemeContext()
	const { setNostr } = useNostrContext()
	const {
		mint,
		amount,
		memo,
		estFee,
		isMelt,
		isSendEcash,
		nostr,
		isSwap,
		isZap,
		payZap,
		targetMint,
		proofs,
		recipient
	} = route.params

	const handleError = ({ e, customMsg }: IErrorProps) => {
		const translatedErrMsg = t(customMsg || 'requestMintErr', { ns: NS.error })
		navigation.navigate('processingError', {
			amount,
			mint,
			errorMsg: isErr(e) ? e.message : translatedErrMsg
		})
	}

	const getErrObj = (mint: IMintUrl, amount: number, fallbackMsg: string, e?: unknown) => ({
		mint,
		amount,
		errorMsg: isErr(e) ? e.message : fallbackMsg
	})

	const processingTxt = useMemo(() => {
		if (isZap && !payZap) { return 'prepairZapData' }
		if (isMelt || (isZap && payZap)) { return 'processingPaymentByMint' }
		if (isSwap) { return 'processingSwap' }
		if (isSendEcash) {
			if (nostr) {
				return 'sendingEcashViaNostr'
			}
			return 'creatingEcashToken'
		}
		return 'awaitingInvoice'
	}, [isMelt, isSwap, isZap, payZap, isSendEcash, nostr])

	const handleMinting = async () => {
		try {
			const resp = await requestMint(mint.mintUrl, amount)
			const decoded = decodeLnInvoice(resp.pr)
			// navigate to invoice overview screen
			navigation.navigate('mintInvoice', {
				mintUrl: mint.mintUrl,
				amount,
				hash: resp.hash,
				expiry: decoded.expiry,
				paymentRequest: decoded.decoded.paymentRequest
			})
		} catch (e) {
			handleError({ e })
		}
	}

	const handleMelting = async () => {
		let invoice = ''
		// recipient can be a LNURL (address) or a LN invoice
		if (recipient?.length && isLnurl(recipient)) {
			try {
				invoice = await getInvoiceFromLnurl(recipient, +amount)
				if (!invoice?.length) {
					handleError({ customMsg: 'invoiceFromLnurlError' })
					return
				}
			} catch (e) {
				handleError({ e })
				return
			}
		}
		try {
			const target = invoice || recipient || ''
			const res = await payLnInvoice(mint.mintUrl, target, estFee || 0, proofs || [])
			if (!res?.result?.isPaid) {
				// here it could be a routing path finding issue
				handleError({ e: isErr(res.error) ? res.error : undefined })
				return
			}
			// payment success, add as history entry
			await addLnPaymentToHistory(
				res,
				[mint.mintUrl],
				-amount - (res?.realFee ?? 0),
				target
			)
			// update latest 3 history entries
			await updateLatestHistory({
				amount: -amount - (res?.realFee ?? 0),
				fee: res.realFee,
				type: 2,
				value: target,
				mints: [mint.mintUrl],
				timestamp: Math.ceil(Date.now() / 1000)
			})
			navigation.navigate('success', {
				amount,
				fee: res.realFee,
				isMelt: true,
				isZap
			})
		} catch (e) {
			handleError({ e })
		}
	}

	const handleSwap = async () => {
		if (!targetMint?.mintUrl?.trim()) {
			return handleError({ e: `targetMint: ${targetMint?.mintUrl} is invalid` })
		}
		// simple way
		try {
			const res = await autoMintSwap(mint.mintUrl, targetMint.mintUrl, amount, estFee ?? 0)
			// add as history entry (multimint swap)
			await addToHistory({
				amount: -amount - (res?.payResult?.realFee ?? 0),
				fee: res.payResult.realFee,
				type: 3,
				value: res.requestTokenResult.invoice?.pr || '',
				mints: [mint.mintUrl],
				recipient: targetMint?.mintUrl || ''
			})
			navigation.navigate('success', {
				amount,
				fee: res.payResult.realFee,
				isMelt: true
			})
		} catch (e) {
			handleError({ e })
		}
	}

	const handleSendingEcash = async () => {
		try {
			const token = await sendToken(mint.mintUrl, amount, memo || '', proofs)
			// add as history entry (send ecash)
			const entry = await addToHistory({
				amount: -amount,
				type: 1,
				value: token,
				mints: [mint.mintUrl],
				recipient: getNostrUsername(nostr?.contact)
			})
			// https://github.com/nostr-protocol/nips/blob/master/04.md#security-warning
			if (nostr) {
				const published = await pool.publishEvent({ nostr, amount, token })
				if (!published) {
					return navigation.navigate(
						'processingError',
						getErrObj(mint, amount, t('eventError', { ns: NS.common }))
					)
				}
				setNostr(prev => {
					if (!nostr.contact) { return prev }
					return { ...prev, recent: uniqByIContacts([...prev.recent, nostr.contact], 'hex') }
				})
				return navigation.navigate('success', { amount, nostr })
			}
			navigation.navigate('encodedToken', { entry })
		} catch (e) {
			navigation.navigate(
				'processingError',
				getErrObj(mint, amount, t('createTokenErr', { ns: NS.common }), e)
			)
		}
	}

	const handleZap = async () => {
		if (!recipient) {
			return navigation.navigate('processingError', {
				mint,
				amount,
				errorMsg: ''
			})
		}
		try {
			const { amount, timeLeft } = decodeLnInvoice(recipient)
			if (timeLeft <= 0) {
				return navigation.navigate('processingError', {
					mint,
					amount,
					errorMsg: t('invoiceExpired', { ns: NS.common })
				})
			}
			// user has default mint, check default mint balance
			const defaultMint = await getDefaultMint()
			if (defaultMint) {
				const defaultBalance = await getMintBalance(defaultMint)
				const estFee = await checkFees(defaultMint, recipient)
				// if default mint balance + estFee is sufficient, use it
				if (defaultBalance + estFee >= amount) {
					return navigation.navigate('coinSelection', {
						mint: { mintUrl: defaultMint, customName: '' },
						balance: defaultBalance,
						amount: +amount,
						estFee,
						isZap,
						recipient
					})
				}
			}
			// otherwise, check mint with highest balance
			const { mints, highestBalance, highestBalanceMint } = await getHighestBalMint()
			// if highest balance + estFee is sufficient, use it
			if (highestBalanceMint) {
				// TODO need to handle the case where the highest balance mint is not reachable?
				const estFee = await checkFees(highestBalanceMint.mintUrl, recipient)
				if (highestBalance + estFee >= amount) {
					return navigation.navigate('coinSelection', {
						mint: mints.find(m => m.mintUrl === highestBalanceMint.mintUrl) || { mintUrl: 'N/A', customName: 'N/A' },
						balance: highestBalanceMint.amount,
						amount: +amount,
						estFee,
						isZap,
						recipient
					})
				}
			}
		} catch (e) {
			return handleError({ e })
		}
		// otherwise, show error
		navigation.navigate('processingError', {
			mint,
			amount,
			errorMsg: t('noFunds', { ns: NS.common })
		})
	}

	// start payment process
	useEffect(() => {
		if (isZap) {
			if (payZap) {
				return void handleMelting()
			}
			return void handleZap()
		}
		if (isMelt) {
			return void handleMelting()
		}
		if (isSwap) {
			return void handleSwap()
		}
		if (isSendEcash) {
			return void handleSendingEcash()
		}
		void handleMinting()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isMelt, isSwap, isZap, payZap, isSendEcash])

	// prevent back navigation - https://reactnavigation.org/docs/preventing-going-back/
	useEffect(() => {
		const backHandler = (e: TBeforeRemoveEvent) => preventBack(e, navigation.dispatch)
		navigation.addListener('beforeRemove', backHandler)
		return () => navigation.removeListener('beforeRemove', backHandler)
	}, [navigation])

	return (
		<View style={[globals(color).container, styles.container]}>
			<Loading size={40} nostr={!!nostr} />
			<Txt
				styles={[styles.descText]}
				txt={t(processingTxt)}
			/>
			<Txt styles={[styles.hint, { color: color.TEXT_SECONDARY }]} txt={t('invoiceHint')} />
		</View>
	)
}

const styles = StyleSheet.create({
	container: {
		paddingTop: 0,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 20
	},
	descText: {
		marginTop: 20,
		textAlign: 'center',
	},
	hint: {
		fontSize: 14,
		marginTop: 10,
	}
})