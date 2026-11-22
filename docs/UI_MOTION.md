# Hiệu ứng giao diện

JavaScript nằm trong `frontend/js/motion.js`, CSS trong `frontend/styles/motion.css`. Đây là nơi quản lý hiệu ứng chung; không rải transition/keyframe theo từng lớp giao diện nữa. Giữ màu sắc, kích thước và bố cục trong các file CSS còn lại.

## Phạm vi

| Nhóm      | Nội dung được áp dụng                                               |
| --------- | ------------------------------------------------------------------- |
| Chrome    | Utility bar, masthead, menu và thanh tìm kiếm                       |
| Intro     | Tiêu đề trang và breadcrumb                                         |
| Feature   | Hai khối tin nổi bật                                                |
| Section   | Tiêu đề các khu vực nội dung                                        |
| Card      | Thẻ tin trong feed và tin liên quan                                 |
| Sidebar   | Bảng thông tin                                                      |
| Community | Khối kết nối cộng đồng                                              |
| Article   | Nhãn, tiêu đề, meta, ảnh, nguồn, nội dung và thời gian cập nhật bài |
| Workspace | Tab, tổng quan, bộ lọc và thanh tìm lịch sử                         |
| Stat      | Các số liệu thật của khu biên tập                                   |
| Editorial | Danh sách bài, hàng chờ, các mục quản lý/vận hành                   |
| History   | Tiêu đề và các dòng lịch sử                                         |
| Results   | Số kết quả và phân trang                                            |
| Empty     | Trạng thái chưa có kết quả/lỗi tải                                  |
| Loading   | Chú thích tải, skeleton và spinner thao tác                         |
| Footer    | Các cột thông tin và dòng cuối trang                                |

Các nhóm trên có hiệu ứng xuất hiện một lần trên mỗi phần tử. MutationObserver đăng ký nội dung mới sau khi tìm kiếm, phân trang hoặc đổi tab; gọi refresh nhiều lần không phát lại hiệu ứng cho phần tử đã hiển thị.

Tương tác bổ sung: gạch chân menu, hover/nhấn nút, focus ô nhập, mở/đóng bộ lọc/tổng quan, mở/đóng hộp thoại, trạng thái form, thông báo, tiến độ đọc và nút về đầu trang. Các nút chuyên mục giữ nguyên DOM khi chuyển trang để giữ focus và chuyển trạng thái liên tục.

## Ràng buộc

- Nội dung luôn hiện dù JavaScript observer hoặc animation không có sẵn; không dùng opacity 0 làm trạng thái chờ cuộn.
- Hiệu ứng không phát lại trên vùng đang nhập liệu. Không làm rung trường nhập hoặc dùng parallax/hiệu ứng lặp để trang trí.
- Dialog chỉ đóng sau khi kiểm tra bản nháp chưa lưu và trạng thái đang gửi. Chuyển cảnh kết thúc rồi mới phục hồi focus; mở dialog mới hủy tác vụ đóng cũ.
- Details xử lý đảo chiều liên tiếp và khôi phục chiều cao tự nhiên khi kết thúc. Chuyển chế độ giảm chuyển động giữa lúc mở/đóng vẫn hoàn tất đúng trạng thái.
- `prefers-reduced-motion` tắt CSS animation/transition, hủy Web Animations đang chạy và dùng cuộn tức thì.
- Vercel giữ chế độ đọc công khai; hiệu ứng không mở lại chức năng biên tập hay thay đổi xác thực.

## Kiểm tra

```powershell
# Server local đang chạy; biến này chỉ dùng tài khoản thật trên máy hiện tại.
$env:ADMIN_LOGIN_FILE='storage/private/admin-login.txt'
npm run test:ui:motion
npm run test:ui:audit
npm run test:workflow
```

`test:ui:motion` ghi nhận các animation thực sự được phát trên trình duyệt, kiểm tra 16 nhóm khi có quyền biên tập local, hoặc 12 nhóm public trên Vercel. Có kiểm tra dynamic DOM, không phát lại khi refresh, form đang nhập, mở lại dialog khi đang đóng, thao tác details liên tiếp và reduced motion giữa hiệu ứng. Ảnh cùng kết quả nằm trong `storage/reports/ui-motion/`.

```powershell
# Bỏ credential local trước khi kiểm tra website công khai.
Remove-Item Env:ADMIN_LOGIN_FILE -ErrorAction SilentlyContinue
$env:TEST_BASE_URL='https://uth-campus-news.vercel.app'
npm run test:ui:motion
```

Số nhóm là phạm vi kiểm tra cụ thể, không phải cam kết mọi điểm ảnh đều phải chuyển động. Người bật giảm chuyển động được giữ giao diện ổn định.
