export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const [requestUrl, requestUrlError] = trySync(() => new URL(request.url));
		if (requestUrlError) {
			return new Response('Invalid request URL', { status: 400 });
		}
		const imageUrl = requestUrl.searchParams.get('url');

		if (!imageUrl) {
			return new Response('Image URL must be provided', { status: 400 });
		}

		const [, imageUrlParseError] = trySync(() => new URL(imageUrl));
		if (imageUrlParseError) {
			return new Response('Invalid image URL', { status: 400 });
		}

		const [imageUrlHash, hashError] = await tryAsync(() => sha256(imageUrl));
		if (hashError) {
			return new Response('Failed to hash image URL', { status: 500 });
		}

		const imageKey = `uploadedImages/${imageUrlHash}`;

		const { R2_BUCKET } = env;
		const [storedImage] = await tryAsync(() => R2_BUCKET.get(imageKey));
		if (storedImage) {
			return new Response(storedImage.body, {
				headers: {
					'Content-Type': storedImage.httpMetadata?.contentType || 'application/octet-stream',
				},
			});
		}

		const [imageResponse, imageFetchError] = await tryAsync(() => fetch(imageUrl));
		if (imageFetchError) {
			return new Response(`Failed to fetch the image: ${imageUrl}`);
		}

		if (!imageResponse.ok || !imageResponse.body) {
			return new Response(`Failed to fetch the image: ${imageResponse.statusText}`, {
				status: imageResponse.status,
			});
		}

		const { readable, writable } = new TransformStream();
		ctx.waitUntil(uploadImage(R2_BUCKET, imageResponse.clone(), imageKey));
		imageResponse.body.pipeTo(writable);
		return new Response(readable, {
			headers: {
				'Content-Type': imageResponse.headers.get('Content-Type') || 'application/octet-stream',
			},
		});
	},
};

async function uploadImage(bucket: R2Bucket, response: Response, storageKey: string) {
	try {
		const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
		await bucket.put(storageKey, response.body, {
			httpMetadata: { contentType },
		});
		console.log(`Image uploaded successfully to ${storageKey}`);
	} catch (error) {
		console.error('Failed to upload image:', error);
	}
}

async function sha256(message: string) {
	const msgBuffer = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

type Result<T, E> = [T, null] | [null, E];
function trySync<T>(fn: () => T): Result<T, Error> {
	try {
		let result = fn();
		return [result, null];
	} catch (e) {
		return [null, e as Error];
	}
}

type AsyncResult<T> = Result<T, Error>;
async function tryAsync<T>(asyncFn: () => Promise<T>): Promise<AsyncResult<T>> {
	try {
		const response = await asyncFn();
		return [response, null];
	} catch (error) {
		return [null, error as Error];
	}
}
