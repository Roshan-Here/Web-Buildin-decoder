#!/usr/bin/env sh
# Makes the test videos for the example and the browser check (needs ffmpeg with libx265).
set -e
dir="$(dirname "$0")/../examples/basic/media"
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
echo "Test videos written to $(pwd)"
