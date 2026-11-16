# Khắc phục UI audit 16/11/2026

| Vấn đề                               | Thay đổi                                                                                         | Kiểm chứng                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Nội dung chưa lưu bị mất             | Cảnh báo đóng/rời, backup session theo tài khoản/phiên bản, xóa sau lưu hoặc logout              | Workflow DB tạm kiểm tra hủy đóng, đóng có xác nhận, reload và khôi phục |
| Back/Reload mất trạng thái           | State nằm trong URL; popstate đọc lại, giữ vị trí cuộn                                           | test:ui:audit                                                            |
| Tìm kiếm giới hạn ngầm               | Search đầu trang xóa phạm vi chuyên mục                                                          | test:ui:audit                                                            |
| Chữ vàng thiếu tương phản            | Chữ trắng trên teal, underline vàng                                                              | Kiểm tra màu render thực; khoảng 4.52:1                                  |
| Phân trang mất ngữ cảnh              | Chỉ cập nhật feed có sẵn; focus đầu danh sách, URL theo trang                                    | test:ui:audit                                                            |
| Dialog không tên/focus               | aria-labelledby, focus input hoặc heading, trả focus khi đóng                                    | test:ui:audit + workflow                                                 |
| Ảnh không bấm được                   | Liên kết ảnh hero và ảnh tin phụ                                                                 | Browser checks                                                           |
| Hộp ảnh kế thừa margin/position      | Reset media component, contain ảnh hero, hộp ảnh nằm trong khung                                 | Đo bounding boxes ở 320–2560 px                                          |
| Mobile nhiều lớp header/stats/filter | Utility chữ ngắn cỡ 11px; header gọn giữ logo giữa; thống kê và bộ lọc thu/mở; thẻ feed dạng gọn | Ảnh chụp và số đo trong storage/reports/ui-audit-fixed                   |
| Lịch sử mở bài mới nhất              | API snapshot private có phân quyền và modal đúng version                                         | API test + workflow xuất bản hai phiên bản                               |
| Campus logo chưa sắc nét             | Wordmark/icon SVG riêng và favicon đồng bộ                                                       | Kiểm tra brand center và responsive                                      |

`storage/reports/ui-audit/` giữ bằng chứng trước sửa. `storage/reports/ui-audit-fixed/` giữ số đo/ảnh sau sửa. Các thư mục output không đưa lên Git.

Không coi các kiểm tra này là chứng nhận WCAG đầy đủ; đã kiểm chứng các lỗi cụ thể trong audit.
