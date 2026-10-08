import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })))
vi.mock('node:child_process', () => ({ spawn }))

import { openInBrowser } from '../src/user.js'

const platform = process.platform

afterEach(() => {
	Object.defineProperty(process, 'platform', { value: platform })
	spawn.mockClear()
})

describe('opening the sign-in page', () => {
	// `cmd /c start` would split the URL at the `&` between query parameters.
	it('hands the URL to Windows as one argument, without a shell', async () => {
		Object.defineProperty(process, 'platform', { value: 'win32' })
		const url = 'https://gw.test/oauth/authorize?client_id=c-1&state=s-1'

		await openInBrowser(url)

		expect(spawn).toHaveBeenCalledWith('rundll32', ['url.dll,FileProtocolHandler', url], {
			stdio: 'ignore',
			detached: true,
			shell: false,
		})
	})

	it('opens nothing that is not a web page', async () => {
		await openInBrowser('ftp://gw.test/oauth/authorize')

		expect(spawn).not.toHaveBeenCalled()
	})
})
