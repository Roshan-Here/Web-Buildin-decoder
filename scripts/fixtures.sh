#!/usr/bin/env sh
# Makes the test videos for the example and the browser check (needs ffmpeg with libx265).
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/examples/basic/media"
mkdir -p "$dir"
cd "$dir"
printf '1\n00:00:00,500 --> 00:00:15,000\nHello from the English track\n\n2\n00:00:15,000 --> 00:00:30,000\nSecond English line\n' > en.srt
printf '1\n00:00:00,500 --> 00:00:30,000\nHola desde la pista\n' > es.srt
ffmpeg -loglevel error -y \
  -f lavfi -i testsrc2=size=854x480:rate=24 \
  -f lavfi -i sine=frequency=330:sample_rate=48000 \
  -f lavfi -i sine=frequency=660:sample_rate=48000 \
  -i en.srt -i es.srt -t 30 \
  -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s \
  -c:v libx265 -preset ultrafast -x265-params log-level=error -b:v 1200k -pix_fmt yuv420p \
  -c:a:0 ac3 -c:a:1 aac -ac 2 -c:s srt \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=spa -metadata:s:a:1 title="Spanish 2.0" \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa \
  sample-hevc-ac3.mkv
ffmpeg -loglevel error -y \
  -f lavfi -i testsrc2=size=854x480:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 30 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
  sample-h264.mkv
# A PGS subtitle track (a yellow box from 1 s to 4 s, every ten seconds), written by the test
# writer, for the picture subtitle check.
node --experimental-strip-types --no-warnings "$root/scripts/make-picture-subs.ts" picture-subs.sup
ffmpeg -loglevel error -y \
  -f lavfi -i testsrc2=size=854x480:rate=24 -f lavfi -i sine=frequency=330:sample_rate=48000 \
  -i picture-subs.sup -map 0:v -map 1:a -map 2:s -t 30 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest -copyts -c:s copy \
  -metadata:s:s:0 language=eng sample-pgs.mkv
echo "Test videos written to $(pwd)"
