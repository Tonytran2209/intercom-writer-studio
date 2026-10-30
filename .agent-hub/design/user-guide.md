---
id: intercom-user-guide
layer: design
status: canonical
projectId: intercom-writer-studio
verified_source_commit: 4c0b37ae1d3c7c5358c965954ca186bf93209b73
verified_on: 2026-10-28
source_paths: [src/App.tsx, src/components/EbSidebar.tsx, src/components/EbWorkingSpace.tsx, src/components/config/ConfigModal.tsx, backend/ebV2.ts, backend/providers.ts, backend/briefValidation.ts]
---
# Hướng dẫn sử dụng Intercom Writer Studio

## Bắt đầu: app làm được gì?
Intercom Writer Studio / F.Learning EB Article Writer biến ý tưởng hoặc tài liệu thực tế thành brief, bài website fab.careers và nội dung Threads, Facebook, LinkedIn. Luồng chính là **Brief · Gate 1 → Website article · Gate 2 → Adapt channel → Review · Gate 3**. Mỗi thẻ là một công việc; mở thẻ để xem output, nguồn và hoạt động AI.

Hướng dẫn này mô tả EB V2 đang được `src/App.tsx` mở mặc định. Các màn hình article/SEO legacy còn trong repo không phải luồng khởi tạo của EB V2. Sau màn hình tải settings, app hiển thị hướng dẫn nhẹ 3 bước nếu trình duyệt chưa có dấu `writer:onboarding:v1`: chuẩn bị model/thư viện, input/dẫn chứng và Analyze; giải thích Gate, sửa Source & evidence, Approve brief → Approve article → review từng kênh và Threads A/B; Discovery, tìm lại bài và xử lý lỗi. Mỗi bước dùng danh sách ngắn với tên thao tác in đậm, có nội dung Việt/Anh tương đương. Dùng **Tiếp**, **Quay lại**, **Bỏ qua**, **Đóng** (hoặc Escape) và **Bắt đầu**. Đóng/bỏ qua/hoàn tất mới lưu dấu, nên lần tải lại không tự mở. Dấu áp dụng theo trình duyệt/origin, không theo tài khoản; người dùng cũ chưa có dấu cũng thấy một lần. Nếu storage bị chặn, vẫn đóng được và nhớ trong lần mount hiện tại; tải lại có thể hiện lại. Nút **Hướng dẫn** cạnh Search ở cuối sidebar (biểu tượng dấu hỏi khi thu gọn), hoặc cạnh Search trên thanh điều hướng mobile, mở lại từ bước đầu, giữ nguyên workspace và nội dung đang nhập, không chạy AI hay chuyển Gate.

## 1. Chuẩn bị Workspace và model
- Người phụ trách cấu hình mở **Settings → Workflow AI**, chọn model đang bật cho các bước; Gate 1 dùng model Brief, duyệt brief dùng model Article và duyệt article dùng model Adapt.
- **AI Models** quản lý model/provider. **EB Knowledge & Rules** chứa EB Library, EB Workflow Rules và Website Inventory. Chuẩn bị tài liệu pillar, persona, article và Channel Rules phù hợp trước khi viết.
- Khả năng quét ảnh phụ thuộc model/provider hỗ trợ ảnh. Khi nút bị khóa hoặc có lỗi model, kiểm tra cấu hình của đúng bước; không mặc định mọi model đều đọc được ảnh.

## 2. New activity: tạo brief từ input hoặc tài liệu
1. Chọn **New activity** ở sidebar, nhập topic cùng bối cảnh thật, mối liên hệ với F/F.Learning hoặc sự kiện của F và nguồn xác nhận.
2. Có thể dùng biểu tượng upload tài liệu trong InputEngine. Nội dung tải lên đi qua xử lý tài liệu và validation của app.
3. Bấm **Analyze**. Khi hợp lệ, ứng dụng tạo package và brief ở Gate 1.
4. Nếu xuất hiện **Cần bổ sung**, hoàn thiện các mục hiển thị, mở **Xem chi tiết** khi cần rồi gửi lại. Duyệt rủi ro hay bấm lại nhiều lần không thay thế thông tin còn thiếu.

## 3. Nhập ảnh để AI đọc Source & evidence
- Trong InputEngine, chọn **icon ảnh cạnh upload tài liệu**, hoặc kéo thả ảnh vào vùng input. Trong popup Gate 1 → **Source & evidence**, bấm **icon ảnh cạnh trường dẫn chứng** hoặc kéo thả ảnh vào vùng dẫn chứng. Phần quét/kết quả chỉ mở khi có ảnh hoặc lỗi.
- Chọn **một ảnh PNG/JPEG/WebP, tối đa 15 MiB mỗi lần**. Chọn ảnh không đồng nghĩa đã dùng nó làm dẫn chứng.
- Bấm **Quét dẫn chứng**, đọc và sửa ô **Dẫn chứng từ ảnh**, sau đó bấm **Dùng dẫn chứng**.
- Với input thường, text đã xác nhận được nối vào nội dung topic. Với phần chuẩn bị từ Discovery hoặc popup Gate 1, text được đưa vào trường dẫn chứng của ngữ cảnh đó.
- AI đọc nội dung nhìn thấy trong ảnh, không xác minh độc lập tính đúng/sai của nguồn. Người dùng cần kiểm tra text, link và thông tin về F trước khi áp dụng.
- Nếu ảnh không hợp lệ, model không hỗ trợ hoặc quét lỗi, giữ nội dung đã nhập và thử lại đúng thao tác. Đổi ảnh/task sẽ hủy hoặc bỏ qua phản hồi cũ. Ảnh được xử lý tạm thời; text người dùng xác nhận mới đi vào snapshot hiện có. Quét ảnh không tự chạy brief hay tự duyệt Gate 1.

## 4. Gate 1: xem, sửa nguồn và duyệt brief
- Mở thẻ brief để xem kết quả, **Mối liên hệ với F** và **Dẫn chứng / nguồn xác nhận tại F** từ snapshot của task.
- Hai ô nguồn hiển thị gọn và có thể kéo giãn; mở **Source snapshots** để đọc snapshot đã lưu, không làm mất nội dung đang sửa.
- Sửa các trường rồi chọn **Lưu và chạy lại brief** khi cần. Validation diễn ra trước khi lưu/chạy; lỗi giữ lại giá trị để sửa.
- Sau khi brief mới chạy thành công, đọc lại rồi chọn **Approve brief** từ thẻ hoặc popup. Bước này tạo Website article ở Gate 2.
- Khi đang chạy lại hoặc lần chạy mới thất bại, brief cũ không đủ điều kiện duyệt thay cho lần mới. Sau lỗi mạng, refresh workspace để xem trạng thái đã lưu trước khi thử lại.

## 5. Gate 2 và Adapt: bài website và các kênh
- Mở **Website article · Gate 2** để đọc bài fab.careers. Chọn **Approve article** từ thẻ hoặc popup khi phù hợp; app dùng model Adapt để tạo output theo kênh.
- Các hành động đang chạy được khóa để tránh gửi trùng. Nếu thiếu model hoặc có lỗi, xem thông báo ở đúng thao tác và giữ kết quả đã lưu.
- Bài website vẫn có thể mở lại từ **Website articles** sau khi đã chuyển sang review kênh.

## 6. Gate 3: review theo từng output
- Mở task, chọn kênh cần đọc trong **Channel output**. Quyết định **Done**, **Reject**, **Re-check** và regenerate chỉ áp dụng đúng output/kênh đang chọn.
- Threads yêu cầu **Variant A / Variant B**, mỗi variant có **Tiếng Việt và English**, tối đa 500 ký tự cho mỗi ngôn ngữ theo hợp đồng prompt. Đọc lại nội dung thực tế; prompt không phải bộ kiểm định ngôn ngữ/độ dài tuyệt đối.
- Khi duyệt Threads, chọn **A, B hoặc cả hai** theo lựa chọn được cung cấp. Trạng thái đã lưu vẫn được giữ khi tải lại.
- Thẻ task hiển thị **Done / Rejected / Chờ review** cùng số lượng dựa trên toàn bộ output hiện hành, độc lập bộ lọc kênh. Menu **Done tất cả / Reject tất cả** xử lý tuần tự các output cần đổi; Done tất cả cần chọn variant cho Threads chưa duyệt.
- Nếu lỗi giữa chừng, giữ phần đã xác nhận và retry phần chưa hoàn tất. Không hiểu lỗi của một output là tất cả output đã thất bại hoặc đã được duyệt.

## 7. Refine with AI và duyệt Threads trong chat
1. Mở **Refine with AI** ở output cần chỉnh, nhập yêu cầu rồi chờ revision hoàn tất.
2. Kiểm tra song ngữ và nội dung của revision. **Use this version** kích hoạt revision; không đồng nghĩa đã review Done.
3. Với Threads, **Approve A / Approve B** trong chat kích hoạt đúng revision trước rồi lưu lựa chọn review. Chat vẫn mở và theo revision đang hoạt động.
4. Nếu kích hoạt thành công nhưng review lỗi, retry chỉ hoàn tất phần review còn thiếu. Refresh để đối chiếu trạng thái sau khi mất phản hồi; revision đã accepted/done không nên bị kích hoạt lại hoặc ghi đè bằng lần gửi trùng.

## 8. Discovery: tìm ý tưởng có nguồn
- Chọn **Discovery**, bấm **Scan sources** để quét các nguồn đã cấu hình; có thể thêm link nguồn tham khảo.
- Đọc **Details** trước khi dùng. Các nhóm **Verified trend**, **Emerging signal**, **Source lead** có mức bằng chứng khác nhau; nhãn xu hướng không tự xác nhận liên hệ với F.
- Chọn **Run Gate 1** để mở phần chuẩn bị. Bổ sung liên hệ với F và nguồn xác nhận, có thể quét ảnh để hỗ trợ nhập dẫn chứng, rồi gửi qua validation.
- Discovery archive giữ gợi ý đã lưu. Xóa riêng hoặc Clear all có xác nhận; Clear all giữ các gợi ý đã sử dụng/package theo hành vi hiện tại.

## 9. Tìm lại bài và xem thông báo
- Sidebar: **New activity**, **Discovery**, **Website articles**, **Final review**, **Library Article**, Search, **Hướng dẫn** và Settings. Trên mobile, Search/Hướng dẫn nằm cùng một hàng riêng trong thanh điều hướng. Popup hướng dẫn cuộn phần nội dung trên màn hình thấp, giữ các nút thao tác hiển thị; khi đóng, focus trở về nút Hướng dẫn đang hiển thị. Danh sách dài có thể cuộn; trên màn hình nhỏ dùng thanh điều hướng và Packages.
- Bấm **chuông thông báo** để mở **Thông báo** hoặc **Trạng thái hệ thống**. Mở thông báo để xem ngữ cảnh, chi tiết và log thay vì suy luận từ số badge.
- Chấm kết nối và nút refresh/retry cho biết tình trạng workspace. Trạng thái live không chứng minh mọi provider AI đang khỏe. Sau reload, lịch sử thông báo của phiên có thể mất, trong khi dữ liệu workspace đã lưu vẫn đọc từ server.
- Dùng copy/export của output đang xem nếu phù hợp. App hỗ trợ chuẩn bị nội dung và quyết định review; người dùng thực hiện việc xuất bản lên kênh bên ngoài.

## 10. Khi lỗi hoặc cần gửi feedback
- Thiếu thông tin: sửa topic/liên hệ/nguồn cụ thể theo danh sách validation.
- Lỗi model/provider: kiểm tra model của đúng bước, giữ output đã lưu, tránh bấm generate liên tiếp.
- Lỗi kết nối/mất phản hồi: refresh và đọc lại trạng thái trước khi retry thao tác có thể đã được lưu.
- Feedback hữu ích gồm tên task, Gate, kênh, thao tác, kết quả mong muốn và ảnh đã loại thông tin nhạy cảm. Không gửi API key, mật khẩu hoặc toàn bộ dữ liệu riêng tư.

## Đối chiếu source cho AI Agent Lab
| Nội dung | Source đã đối chiếu |
| --- | --- |
| EB V2 mặc định, tải settings | `src/App.tsx` |
| Sidebar, tìm kiếm, mở package | `src/components/EbSidebar.tsx` |
| Input, ảnh, Gate 1–3, Discovery, refine, notification | `src/components/EbWorkingSpace.tsx` |
| Model và thư viện cấu hình | `src/components/config/ConfigModal.tsx`, `src/components/config/TabStepSetup.tsx`, `src/components/config/TabKnowledgeBase.tsx` |
| API nguồn ảnh, snapshot và guard Gate | `src/lib/db.ts`, `backend/ebV2.ts`, `backend/briefValidation.ts` |
| Vision payload và hợp đồng provider | `backend/providers.ts` |

Các bước trên mô tả hành vi ở commit đã xác minh, không cấp quyền chỉnh code/deploy hoặc thay thế việc đọc source hiện tại. Khi hành vi thay đổi, cập nhật hướng dẫn này cùng flow/API canonical liên quan.
