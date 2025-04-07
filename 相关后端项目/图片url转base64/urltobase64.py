from flask import Flask, request, jsonify
import requests
from io import BytesIO
from PIL import Image
import imageio
import base64

app = Flask(__name__)

def download_image_with_retry(url, retries=3):
    for attempt in range(retries):
        try:
            response = requests.get(url)
            response.raise_for_status() 
            return BytesIO(response.content) 
        except Exception as e:
            print(f"Attempt {attempt + 1} failed: {e}")
            if attempt == retries - 1:
                raise
    return None

def check_image_format(buffer):
    header = buffer.read(8)  
    buffer.seek(0)

    if header.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    elif header.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    elif header.startswith(b'GIF89a') or header.startswith(b'GIF87a'):
        return 'gif'
    elif header.startswith(b'BM'):
        return 'bmp'
    elif header.startswith(b'RIFF') and buffer.read(4)[8:12] == b'WEBP':
        return 'webp'
    else:
        return 'unknown'

def is_animated_gif(buffer):
    try:
        buffer.seek(0)
        buffer_copy = BytesIO(buffer.read())
        gif = imageio.get_reader(buffer_copy)
        return gif.get_length() > 1 
    except Exception as e:
        print(f"Error checking animated GIF: {e}")
        return False

def convert_static_gif(buffer):
    try:
        buffer.seek(0) 
        img = Image.open(buffer)
        png_buffer = BytesIO()
        img.save(png_buffer, format='PNG')
        png_buffer.seek(0)
        return png_buffer
    except Exception as e:
        print(f"Error converting GIF to PNG: {e}")
        return None

@app.route('/image-to-base64', methods=['POST'])
def image_to_base64():
    data = request.get_json()
    url = data.get('url')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    try:
        buffer = download_image_with_retry(url)
        if not buffer:
            return jsonify({'error': 'Failed to download image'}), 500

        image_format = check_image_format(buffer)
        if image_format == 'unknown':
            return jsonify({'error': 'Unsupported image format'}), 400

        buffer.seek(0)

        final_buffer = buffer
        final_format = image_format

        if image_format == 'gif':
            if is_animated_gif(buffer):
                final_format = 'gif'
            else:
                final_buffer = convert_static_gif(buffer)
                if final_buffer is None:
                    return jsonify({'error': 'Failed to convert GIF to PNG'}), 500
                final_format = 'png'

        final_buffer.seek(0)
        base64_data = base64.b64encode(final_buffer.read()).decode('utf-8')

        return jsonify({'base64': base64_data, 'format': final_format})
    except Exception as e:
        print(f"Error processing image: {e}")
        return jsonify({'error': f'An error occurred while processing the image: {e}'}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=46678)