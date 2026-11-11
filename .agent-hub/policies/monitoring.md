---
schema: agent-hub/monitoring-policy/v1
projectId: intercom-writer-studio
---

# Monitoring readiness policy — Intercom Writer Studio

Mọi AI agent (Codex, Claude Code, Cursor, Copilot, Gemini hay model khác) phải đọc file này **trước khi sửa code** theo yêu cầu của người dùng. Quy tắc này nằm cạnh các quy tắc khác trong `.agent-hub/policies/` và không thay thế chúng.

## Khi nào áp dụng

Áp dụng khi thay đổi thêm hoặc sửa một bước xử lý: job, bước gọi AI, gửi dữ liệu ra nền tảng ngoài, xử lý nền, hoặc thao tác người dùng bấm để giao việc. Thay đổi chỉ về chữ, giao diện hay tài liệu mà không tạo hoặc sửa bước xử lý nào thì ghi rõ "Không ảnh hưởng monitoring" trong báo cáo cuối.

Báo cáo gửi AI Agent Lab qua `GET /internal/monitoring?days=1..30`, giao thức `app-monitoring-v1`, chuẩn đo trình duyệt `ui-kpi-v2`. Đặc tả đầy đủ nằm trong repo AI Agent Lab, file `docs/app-monitoring.md`.

## 1. Xác định vị trí trong pipeline

- Tính năng thuộc Main Job nào, và là bước thứ mấy.
- Đặt tên sub-job ngắn gọn bằng tiếng Việt, theo dạng hành động (ví dụ "Lập outline"). Dùng đúng một tên đó ở mọi nơi.
- Thêm tên vào `profile.mainJob.steps` đúng thứ tự. Cập nhật mô tả Main Job nếu pipeline thay đổi.

## 2. Ghi log cho mỗi lần chạy (lưu bền, không chỉ in ra console)

Mỗi lần chạy được lưu trong database của app, với các trường:

- `runId`: duy nhất và ổn định cho lần chạy.
- `parentRunId`: `runId` của lần chạy Main Job chứa nó. `parent`: tên Main Job.
- `job`: tên sub-job ở mục 1.
- `status`: `running` | `success` | `failed`.
- `startedAt`: ghi **ngay trước** khi bắt đầu xử lý, tại chính nơi xử lý (server, worker). Không suy ra từ thời điểm tạo bản ghi. Nếu lưu giờ bắt đầu bị lỗi thì vẫn chạy tiếp và thử lưu lại sau, không chặn công việc chính.
- `endedAt`: ghi khi kết thúc, kể cả khi lỗi.
- `items: { total, succeeded }` khi một lần chạy xử lý nhiều đơn vị. Chỉ tính là thành công những đơn vị đã được xác nhận thật.
- `workload` (ở Main Job): `"<Loại workload> · <tên tài liệu/batch>"`. Phần trước dấu " · " là nhóm cố định để Lab gom thống kê, không đưa kích thước hay số lượng vào phần này.
- Lỗi: lưu mã hoặc loại lỗi ngắn gọn để biết vì sao lần chạy thất bại.

Nếu cần cột hoặc bảng mới, viết kèm file migration SQL. Phần đọc báo cáo phải chạy được cả khi migration chưa được áp dụng: thiếu cột thì bỏ trường đó và vẫn trả về phần còn lại.

## 3. Đưa vào báo cáo `/internal/monitoring`

- Thêm các lần chạy vào `jobRuns.runs`, lấy lịch sử tối đa 61 ngày, và đánh dấu `truncated` nếu phải cắt bớt.
- Báo cáo có `protocol`, `appId`, `generatedAt` (giờ hiện tại), `window.days`, và ít nhất một trong các phần `runtime`, `http`, `ai`, `profile`.
- Khai báo `profile.kpiDescriptions` cho chỉ số mới (đo từ đâu đến đâu). Nếu có mục tiêu tỷ lệ lỗi riêng thì khai báo `profile.errorRateTarget`.
- Trả lời trong dưới 12 giây, kích thước dưới 2 MB. Chỉ đọc các cột cần dùng.
- Endpoint yêu cầu `Authorization: Bearer <LAB_MONITORING_TOKEN>` (tối thiểu 32 ký tự). Thiếu token thì trả 404, sai token thì trả 401.

## 4. Thao tác người dùng bấm (chuẩn ui-kpi-v2)

- Điểm bắt đầu là `event.timeStamp` của lần bấm. Nếu giá trị đó không hợp lệ thì dùng `performance.now()` ở đầu hàm xử lý.
- `clickLatency`: từ lúc bấm đến khi giao diện đã vẽ trạng thái "đang xử lý" (khung hình thứ hai, `requestAnimationFrame` lồng hai lần).
- `responseTime`: từ lúc bấm đến khi giao diện cho thấy hệ thống đã nhận việc (job đã tạo, sự kiện stream đầu tiên). **Không phải** thời gian hoàn thành job.
- Tab bị ẩn: chốt mẫu ngay tại thời điểm đó, không bỏ mẫu. Mỗi thao tác chỉ gửi một mẫu cho mỗi chỉ số.
- Lưu mẫu bền (database), rồi báo cáo P95 dạng `{ p95Ms, samples, precision: "exact" }` kèm `performanceKpis.standard = "ui-kpi-v2"`.

## 5. Riêng tư

Không đưa vào log hay báo cáo: tên người, email, URL hồ sơ, nội dung bài viết, tin nhắn hoặc tài liệu, prompt, token, khoá. Chỉ được đưa: tên job, trạng thái, thời gian, số đếm, tên batch hoặc tài liệu do chính người dùng đặt, mã lỗi.

## 6. Kiểm tra trước khi báo xong

- Có test cho phần dựng `jobRuns` của sub-job mới: chạy thành công, chạy lỗi, đang chạy, thiếu `startedAt`.
- Gọi thử `/internal/monitoring` ở máy và kiểm tra sub-job mới xuất hiện với đủ `startedAt`, `endedAt`, `status` và `parentRunId`.
- Trong báo cáo cuối gửi người dùng, nêu rõ: tên sub-job, vị trí trong `profile.mainJob.steps`, file migration (nếu có), và các việc cần làm ngoài code. Ví dụ: chạy SQL, khởi động lại worker chạy ngoài Railway, đặt biến `LAB_MONITORING_TOKEN`.

## Trong repo này

| Nội dung | Vị trí |
| --- | --- |
| Main Job `EB V2 package` và các sub-job theo thứ tự | `backend/packageSteps.ts` (`PACKAGE_JOB`, `pipelineSteps`, `gateStepName`) |
| Lịch sử lần chạy (`jobRuns`), mỗi gate là một sub-job | `backend/jobHistory.ts`, bảng `eb_v2_gate_runs` |
| Endpoint và dựng báo cáo | `backend/monitoring.ts`, route trong `backend/index.ts` |
| Tín hiệu "đã nhận việc" và đo trình duyệt (ui-kpi-v2) | `backend/acceptedStream.ts`, `src/lib/acceptedResponse.ts`, `src/lib/performanceTelemetry.ts`, `src/components/EbWorkingSpace.tsx` |
| Test monitoring | `backend/monitoring.test.ts`, `backend/jobHistory.test.ts`, `backend/packageSteps.test.ts` |

Sub-job mới của một package được thêm vào `pipelineSteps` đúng thứ tự, và `gateStepName` phải ánh xạ gate/stage của nó sang đúng tên đó. Kiểm tra bằng `npm --prefix backend test` và `npm run check`.
