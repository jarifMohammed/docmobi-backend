// ===controller/appointment.controller.js
import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import {
  deleteFromCloudinary,
  uploadOnCloudinary,
} from "../utils/commonMethod.js";
import { User } from "../model/user.model.js";
import { Appointment } from "../model/appointment.model.js";

import { createNotification } from "../utils/notify.js";
import { io } from "../server.js";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM

const normalizeAppointmentType = (t) => {
  const v = String(t || "")
    .toLowerCase()
    .trim();
  if (["physical", "physical_visit", "clinic"].includes(v)) return "physical";
  if (["video", "video_call", "online"].includes(v)) return "video";
  return null;
};

const parseDate = (d) => {
  if (!d) return null;
  const dt = new Date(d); // expect "yyyy-mm-dd"
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const parseJSONMaybe = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// controller/appointment.controller.js - createAppointment function
// Replace the bookedFor section with this:

export const confirmAppointment = catchAsync(async (req, res) => {
  const { appointmentId } = req.params;
  const { status } = req.body;

  if (!appointmentId || !status) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Appointment ID and status are required",
    );
  }

  // Find the appointment
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  // Update appointment status
  const updatedAppointment = await Appointment.findByIdAndUpdate(
    appointmentId,
    { status },
    { new: true },
  );

  if (!updatedAppointment) {
    throw new AppError(
      httpStatus.INTERNAL_ERROR,
      "Failed to update appointment status",
    );
  }

  // Get patient and doctor info for notification
  const patient = await User.findById(appointment.patient);
  const doctor = await User.findById(appointment.doctor);

  // Send notification to patient
  if (patient && status === "accepted") {
    const notificationPayload = {
      userId: patient._id,
      fromUserId: doctor._id,
      type: "appointment_confirmed",
      title: "Appointment Confirmed! 🎉",
      content: `Your appointment with Dr. ${doctor?.fullName || "Doctor"} has been confirmed for ${appointment.appointmentDate} at ${appointment.time}.`,
      appointmentId: appointment._id,
      meta: {
        appointmentType: appointment.appointmentType,
        date: appointment.appointmentDate,
        time: appointment.time,
        patientId: patient._id,
        doctorId: doctor._id,
      },
    };
    await createNotification(notificationPayload);
    // Emit socket event
    io.to(patient._id.toString()).emit(
      "appointment_confirmed",
      notificationPayload,
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment status updated successfully",
    data: updatedAppointment,
  });
});

/**
 * Helper to resolve the bookedFor payload (self or dependent)
 */
const resolveBookedFor = (patient, bookedForRaw) => {
  const bookedForInput = (typeof bookedForRaw === "string" ? JSON.parse(bookedForRaw) : bookedForRaw) || {};
  const typeRaw = String(bookedForInput?.type || "").trim().toLowerCase();

  // 1. Resolve Scope
  let bookingScope = "self";
  if (["dependent", "dependant", "child"].includes(typeRaw)) {
    bookingScope = "dependent";
  } else if (typeRaw && !["self", "me", "myself", ""].includes(typeRaw)) {
    throw new AppError(httpStatus.BAD_REQUEST, "bookedFor.type must be 'self' or 'dependent'");
  }

  // 2. Self Booking
  if (bookingScope === "self") {
    return { type: "self", nameSnapshot: String(patient.fullName || "").trim() };
  }

  // 3. Dependent Booking
  const dependentId = bookedForInput?.dependentId || bookedForInput?._id || bookedForInput?.id;
  if (!dependentId || !mongoose.Types.ObjectId.isValid(dependentId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "A valid dependentId is required for dependent bookings");
  }

  const dependent = (patient.dependents || []).find((dep) => String(dep._id) === String(dependentId));
  if (!dependent) {
    throw new AppError(httpStatus.BAD_REQUEST, "Dependent not found for the current user");
  }

  if (dependent.isActive === false) {
    throw new AppError(httpStatus.BAD_REQUEST, "Dependent is inactive");
  }

  return {
    type: "dependent",
    dependentId: dependent._id,
    nameSnapshot: String(dependent.fullName || "").trim(),
  };
};

/**
 * Helper to upload appointment files in parallel
 */
const uploadAppointmentFiles = async (files, type) => {
  const medicalDocsFiles = files?.medicalDocuments || [];
  const paymentFiles = files?.paymentScreenshot || [];

  // Parallelize all uploads
  const [medicalDocsResults, paymentResults] = await Promise.all([
    Promise.all(medicalDocsFiles.map(file => uploadOnCloudinary(file.buffer, { folder: "docmobi/appointments/medicalDocs", resource_type: "image" }))),
    Promise.all(paymentFiles.map(file => uploadOnCloudinary(file.buffer, { folder: "docmobi/appointments/payment", resource_type: "image" })))
  ]);

  const medicalDocuments = medicalDocsResults.map(up => ({ public_id: up.public_id, url: up.secure_url }));
  const paymentScreenshot = paymentResults[0] ? { public_id: paymentResults[0].public_id, url: paymentResults[0].secure_url } : null;

  if (type === "video" && !paymentScreenshot) {
    throw new AppError(httpStatus.BAD_REQUEST, "Payment screenshot is required for video appointments");
  }

  return { medicalDocuments, paymentScreenshot };
};

export const createAppointment = catchAsync(async (req, res) => {
  const { doctorId, appointmentType, date, time, symptoms, bookedFor } = req.body;
  const patientId = req.user?._id;

  // 1) Validate Users
  const doctor = await User.findById(doctorId);
  if (doctor?.role !== "doctor") throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");

  const patient = await User.findById(patientId);
  if (!patient) throw new AppError(httpStatus.NOT_FOUND, "Patient not found");

  // 2) Resolve booking target and validation
  const bookedForPayload = resolveBookedFor(patient, bookedFor);
  const type = normalizeAppointmentType(appointmentType);
  if (!type) throw new AppError(httpStatus.BAD_REQUEST, "Invalid appointmentType");

  const appointmentDate = parseDate(date);
  if (!appointmentDate) throw new AppError(httpStatus.BAD_REQUEST, "Invalid date format");

  if (!timeRegex.test(time || "")) {
    throw new AppError(httpStatus.BAD_REQUEST, "Time must be HH:MM in 24-hour format");
  }

  // 3) Concurrent File Uploads (Performance Gain 🚀)
  const { medicalDocuments, paymentScreenshot } = await uploadAppointmentFiles(req.files, type);

  // 4) Conflict Check
  const conflict = await Appointment.findOne({
    doctor: doctorId,
    appointmentDate,
    time,
    status: { $in: ["pending", "accepted"] },
  });
  if (conflict) throw new AppError(httpStatus.CONFLICT, "This time slot is already booked");

  // 5) Create Appointment
  const appointment = await Appointment.create({
    doctor: doctorId,
    patient: patientId,
    bookedFor: bookedForPayload,
    appointmentType: type,
    appointmentDate,
    time,
    symptoms,
    medicalDocuments,
    paymentScreenshot,
  });

  // 6) Notifications
  const notificationPayload = {
    userId: doctor._id,
    fromUserId: patient._id,
    type: "appointment_booked",
    title: "New appointment request",
    content: `${patient.fullName} requested an appointment on ${date} at ${time}.`,
    appointmentId: appointment._id,
    meta: {
      appointmentType: type,
      date,
      time,
      patientId,
      patientName: patient.fullName,
      bookedFor: bookedForPayload,
    },
  };

  await createNotification(notificationPayload);
  io.to(doctor._id.toString()).emit("appointment_booked", notificationPayload);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Appointment created successfully",
    data: appointment,
  });
});

export const getAvailableAppointments = catchAsync(async (req, res) => {
  const { doctorId, date } = req.body;

  if (!doctorId || !date) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "doctorId and date are required",
    );
  }

  const doctor = await User.findById(doctorId).select("role weeklySchedule");
  if (doctor?.role !== "doctor") {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");
  }

  const dateObj = new Date(date);
  if (Number.isNaN(dateObj.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid date format");
  }

  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dayName = dayNames[dateObj.getDay()];

  const weeklySchedule = doctor.weeklySchedule || [];
  const daySchedule = weeklySchedule.find(
    (d) => d.day === dayName && d.isActive,
  );

  if (!daySchedule?.slots?.length) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "No schedule for this day",
      data: {
        date,
        day: dayName,
        slots: [],
      },
    });
  }

  const startOfDay = new Date(dateObj);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const existingAppointments = await Appointment.find({
    doctor: doctorId,
    appointmentDate: { $gte: startOfDay, $lt: endOfDay },
    status: { $in: ["pending", "accepted"] },
  }).select("time");

  const bookedTimesSet = new Set(existingAppointments.map((a) => a.time));

  const allSlots = (daySchedule.slots || []).map((slot) => ({
    start: slot.start,
    end: slot.end,
    isBooked: bookedTimesSet.has(slot.start),
  }));

  const availableSlots = allSlots.filter((s) => !s.isBooked);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Available appointment slots fetched",
    data: {
      date,
      day: dayName,
      slots: availableSlots,
    },
  });
});

// getMyAppointments function - এটা already ভালো আছে, শুধু একটু clean করুন

export const getMyAppointments = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const role = req.user.role;

  const { status, doctorId, patientId, page, limit, sortBy, search } =
    req.query;

  // 🔹 Sort logic
  let sort = {};
  if (sortBy === "oldestToNewest") {
    sort = { createdAt: 1 };
  } else {
    sort = { createdAt: -1 };
  }

  // 🔹 Pagination
  const currentPage = Math.max(Number(page) || 1, 1);
  const pageLimit = Math.min(Number(limit) || 10, 100);
  const skip = (currentPage - 1) * pageLimit;

  // 🔹 Role-based filter
  const matchFilter = {};
  if (role === "patient") matchFilter.patient = userId;
  else if (role === "doctor") matchFilter.doctor = userId;
  else if (role === "admin") {
    if (doctorId) matchFilter.doctor = doctorId;
    if (patientId) matchFilter.patient = patientId;
  } else throw new AppError(httpStatus.FORBIDDEN, "Invalid role");

  // 🔹 Status filter
  if (status && status !== "all") matchFilter.status = status;

  // 🔹 Build aggregation pipeline
  const pipeline = [
    { $match: matchFilter },
    // Populate doctor
    {
      $lookup: {
        from: "users",
        localField: "doctor",
        foreignField: "_id",
        as: "doctor",
      },
    },
    { $unwind: "$doctor" },
    // Populate patient
    {
      $lookup: {
        from: "users",
        localField: "patient",
        foreignField: "_id",
        as: "patient",
      },
    },
    { $unwind: "$patient" },
  ];

  // 🔹 Search filter
  if (search) {
    const regex = new RegExp(search, "i");
    pipeline.push({
      $match: {
        $or: [
          { "doctor.fullName": regex },
          { "patient.fullName": regex },
          { "bookedFor.dependentName": regex }, // if already enriched
        ],
      },
    });
  }

  // 🔹 Count total after search
  const countPipeline = [...pipeline, { $count: "total" }];
  const countResult = await Appointment.aggregate(countPipeline);
  const total = countResult[0]?.total || 0;

  // 🔹 Sort + pagination
  pipeline.push(
    { $sort: { ...sort, appointmentDate: 1, time: 1 } },
    { $skip: skip },
    { $limit: pageLimit },
    {
      $project: {
        doctor: { _id: 1, fullName: 1, role: 1, specialty: 1, avatar: 1, fees: 1 },
        patient: { _id: 1, fullName: 1, role: 1, avatar: 1, dependents: 1 },
        appointmentDate: 1,
        time: 1,
        status: 1,
        bookedFor: 1,
        appointmentType: 1,
        createdAt: 1,
        symptoms: 1,
        medicalDocuments: 1,
        paymentScreenshot: 1,
        notes: 1,
        reason: 1,
      },
    },
  );



  // 🔹 Fetch paginated appointments
  let appointments = await Appointment.aggregate(pipeline);

  // 🔹 Enrich dependents info if not already
  appointments = appointments.map((appt) => {
    if (appt.bookedFor?.relationship) return appt;

    if (appt.bookedFor?.type === "dependent" && appt.bookedFor?.dependentId) {
      const patient = appt.patient;

      if (patient?.dependents && Array.isArray(patient.dependents)) {
        const dependent = patient.dependents.find(
          (dep) => String(dep._id) === String(appt.bookedFor.dependentId),
        );

        if (dependent) {
          appt.bookedFor.dependentName = dependent.fullName;
          appt.bookedFor.relationship = dependent.relationship;
        }
      }
    }

    return appt;
  });

  // 🔹 Pagination meta
  const totalPages = Math.ceil(total / pageLimit);
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + appointments.length, total);
  const hasNext = currentPage < totalPages;
  const hasPrev = currentPage > 1;

  // 🔹 Send response
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointments fetched successfully",
    data: appointments,
    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      totalPages,
      from,
      to,
      hasNext,
      hasPrev,
    },
  });
});



/**
 * Helper to verify if a user has permission to update an appointment
 */
const verifyUpdatePermissions = (appointment, user) => {
  const { _id: userId, role } = user;
  const isPatientOwner = role === "patient" && String(appointment.patient) === String(userId);
  const isDoctorOwner = role === "doctor" && String(appointment.doctor) === String(userId);
  const isAdmin = role === "admin";

  if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Unauthorized to update this appointment");
  }

  if (["completed", "cancelled"].includes(appointment.status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Finished appointments cannot be updated");
  }

  return { isPatientOwner };
};

/**
 * Helper to process file updates during appointment modification
 */
const handleUpdateFiles = async (reqFiles, appointment, updates) => {
  const medicalDocsFiles = reqFiles?.medicalDocuments || [];
  const paymentFiles = reqFiles?.paymentScreenshot || [];
  const fileOperations = [];

  if (medicalDocsFiles.length > 0) {
    (appointment.medicalDocuments || []).forEach(doc => {
      if (doc?.public_id) fileOperations.push(deleteFromCloudinary(doc.public_id).catch(() => { }));
    });
    fileOperations.push(
      Promise.all(medicalDocsFiles.map(file =>
        uploadOnCloudinary(file.buffer, { folder: "docmobi/appointments/medicalDocs", resource_type: "image" })
      )).then(results => {
        updates.medicalDocuments = results.map(up => ({ public_id: up.public_id, url: up.secure_url }));
      })
    );
  }

  if (paymentFiles[0]) {
    if (appointment.paymentScreenshot?.public_id) {
      fileOperations.push(deleteFromCloudinary(appointment.paymentScreenshot.public_id).catch(() => { }));
    }
    fileOperations.push(
      uploadOnCloudinary(paymentFiles[0].buffer, { folder: "docmobi/appointments/payment", resource_type: "image" })
        .then(up => { updates.paymentScreenshot = { public_id: up.public_id, url: up.secure_url }; })
    );
  }

  if (fileOperations.length > 0) await Promise.all(fileOperations);
};

/**
 * Helper to collect and validate update fields for an appointment
 */
const getAppointmentUpdateFields = async (body, isPatientOwner, currentUserId) => {
  const { appointmentType, date, time, symptoms, bookedFor } = body;
  const updates = {};

  if (symptoms !== undefined) updates.symptoms = String(symptoms);

  if (appointmentType !== undefined) {
    updates.appointmentType = normalizeAppointmentType(appointmentType);
    if (!updates.appointmentType) throw new AppError(httpStatus.BAD_REQUEST, "Invalid type");
  }

  if (date !== undefined) {
    updates.appointmentDate = parseDate(date);
    if (!updates.appointmentDate) throw new AppError(httpStatus.BAD_REQUEST, "Invalid date");
  }

  if (time !== undefined) {
    if (!timeRegex.test(time || "")) throw new AppError(httpStatus.BAD_REQUEST, "Invalid time");
    updates.time = time;
  }

  if (bookedFor !== undefined) {
    if (!isPatientOwner) throw new AppError(httpStatus.FORBIDDEN, "Only the patient can update bookedFor");
    const patient = await User.findById(currentUserId);
    updates.bookedFor = resolveBookedFor(patient, bookedFor);
  }

  return updates;
};

export const updateAppointment = catchAsync(async (req, res) => {
  const { id } = req.params;
  const appointment = await Appointment.findById(id);
  if (!appointment) throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");

  // 1) Permissions
  const { isPatientOwner } = verifyUpdatePermissions(appointment, req.user);

  // 2) Collect Updates
  const updates = await getAppointmentUpdateFields(req.body, isPatientOwner, req.user._id);

  // 3) Handle Files (Parallel 🚀)
  await handleUpdateFiles(req.files, appointment, updates);

  // 4) Final Validation & Conflict Check
  const finalType = updates.appointmentType || appointment.appointmentType;
  if (finalType === "video" && !updates.paymentScreenshot && !appointment.paymentScreenshot?.url) {
    throw new AppError(httpStatus.BAD_REQUEST, "Payment screenshot required for video");
  }

  const finalDate = updates.appointmentDate || appointment.appointmentDate;
  const finalTime = updates.time || appointment.time;
  const scheduleChanged = (updates.appointmentDate && new Date(updates.appointmentDate).getTime() !== new Date(appointment.appointmentDate).getTime()) ||
    (updates.time && updates.time !== appointment.time);

  if (scheduleChanged) {
    const conflict = await Appointment.findOne({ doctor: appointment.doctor, appointmentDate: finalDate, time: finalTime, status: { $in: ["pending", "accepted"] }, _id: { $ne: appointment._id } });
    if (conflict) throw new AppError(httpStatus.CONFLICT, "Time slot already booked");
  }

  if (Object.keys(updates).length === 0) throw new AppError(httpStatus.BAD_REQUEST, "No changes provided");

  appointment.set(updates);
  await appointment.save();
  await appointment.populate([{ path: "doctor", select: "fullName role specialty avatar fees" }, { path: "patient", select: "fullName role avatar" }]);

  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Appointment updated", data: appointment });
});




//  FIXED: updateAppointmentStatus - Now allows patient to cancel
/**
 * Helper to validate status transitions
 */
const validateStatusTransition = (current, next) => {
  const transitions = {
    pending: ["accepted", "cancelled"],
    accepted: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };

  if (current !== next && !transitions[current]?.includes(next)) {
    throw new AppError(httpStatus.BAD_REQUEST, `Invalid status transition from ${current} to ${next}`);
  }
};

/**
 * Helper to handle completion-specific logic (pricing, commissions)
 */
const handleCompletionLogic = (appointment, { patientName, price, role }) => {
  if (role === "patient") throw new AppError(httpStatus.FORBIDDEN, "Only doctors can complete appointments");

  if (!patientName || String(patientName).trim() !== appointment.patient?.fullName) {
    throw new AppError(httpStatus.BAD_REQUEST, "Patient name mismatch or missing");
  }

  const paidAmount = Number(price);
  if (!Number.isFinite(paidAmount) || paidAmount < (appointment.doctor?.fees?.amount || 0)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid or insufficient paid amount");
  }

  appointment.adminEarning = appointment.appointmentType === "video" ? 40 : 20;
  appointment.paymentVerified = true;
  appointment.paidAmount = paidAmount;
};

/**
 * Helper to dispatch notifications based on status changes
 */
const dispatchStatusNotifications = async (appointment, status, role, actorId) => {
  const patientId = appointment.patient._id;
  const doctorId = appointment.doctor._id;
  const doctorName = appointment.doctor.fullName;
  const patientName = appointment.patient.fullName;

  let notifyUserId, content, type, title;

  switch (status) {
    case "accepted":
      notifyUserId = patientId;
      content = `${doctorName} has accepted your appointment request.`;
      type = "appointment_confirmed";
      title = "Appointment Confirmed! 🎉";
      break;
    case "completed":
      notifyUserId = patientId;
      content = `Your appointment with ${doctorName} has been completed.`;
      type = "appointment_completed";
      title = "Appointment Completed";
      break;
    case "cancelled":
      notifyUserId = role === "patient" ? doctorId : patientId;
      content = role === "patient" ? `${patientName} has cancelled their appointment.` : `Your appointment with ${doctorName} has been cancelled.`;
      type = "appointment_cancelled";
      title = "Appointment Cancelled";
      break;
    default:
      return;
  }

  const payload = {
    userId: notifyUserId,
    fromUserId: actorId,
    type,
    title,
    content,
    appointmentId: appointment._id,
    meta: { status, doctorName, patientName, updatedBy: role },
    sendPush: true,
  };

  await createNotification(payload);
  io.to(notifyUserId.toString()).emit(type, payload);
};

export const updateAppointmentStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { status, patient: inputPatientName, price } = req.body;
  const { _id: userId, role } = req.user;

  const appointment = await Appointment.findById(id)
    .populate("doctor", "fullName fees role")
    .populate("patient", "fullName role");

  if (!appointment) throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");

  // 1) Permissions
  const isDoctorOwner = role === "doctor" && String(appointment.doctor?._id) === String(userId);
  const isPatientOwner = role === "patient" && String(appointment.patient?._id) === String(userId);
  const isAdmin = role === "admin";

  if (!isDoctorOwner && !isPatientOwner && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Unauthorized status update");
  }

  // 2) Role-Specific Restrictions
  if (role === "patient" && status !== "cancelled") {
    throw new AppError(httpStatus.FORBIDDEN, "Patients can only cancel appointments");
  }

  // 3) State Machine Validation
  validateStatusTransition(appointment.status, status);

  // 4) Logic for "completed"
  if (status === "completed") {
    handleCompletionLogic(appointment, { patientName: inputPatientName, price, role });
  }

  // 5) Save & Notify
  appointment.status = status;
  await appointment.save();
  await dispatchStatusNotifications(appointment, status, role, userId);

  // 6) Build Response
  const sessionInfo = status === "completed" ? {
    sessionHolderName: appointment.patient.fullName,
    payableAmount: appointment.doctor?.fees?.amount || 0,
    currency: appointment.doctor?.fees?.currency || "USD",
  } : null;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment status updated",
    data: { appointment, sessionInfo },
  });
});


export const deleteAppointment = catchAsync(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;
  const role = req.user.role;

  const appointment = await Appointment.findById(id);
  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  const isPatientOwner =
    role === "patient" && String(appointment.patient) === String(userId);
  const isDoctorOwner =
    role === "doctor" && String(appointment.doctor) === String(userId);
  const isAdmin = role === "admin";

  if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You are not allowed to delete this appointment",
    );
  }

  if (appointment.status === "completed" && !isAdmin) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Completed appointments cannot be deleted",
    );
  }

  for (const doc of appointment.medicalDocuments || []) {
    if (doc?.public_id) {
      await deleteFromCloudinary(doc.public_id).catch(() => { });
    }
  }

  if (appointment.paymentScreenshot?.public_id) {
    await deleteFromCloudinary(appointment.paymentScreenshot.public_id).catch(
      () => { },
    );
  }

  await appointment.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment deleted successfully",
    data: null,
  });
});

const getDateRangeForView = (view) => {
  const now = new Date();
  now.setMilliseconds(0);
  const end = now;

  let start;

  if (view === "daily") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (view === "weekly") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    start.setDate(start.getDate() - 6);
  } else if (view === "monthly") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return { start, end };
};

/**
 * Helper to calculate doctor-specific earnings
 */
const calculateDoctorEarnings = (appointments, view) => {
  let totalEarnings = 0, physicalEarnings = 0, videoEarnings = 0, physicalCount = 0, videoCount = 0;
  const weeklyByWeekday = [0, 0, 0, 0, 0, 0, 0];

  for (const appt of appointments) {
    const fee = Number(appt.doctor?.fees?.amount || 0);
    totalEarnings += fee;

    if (appt.appointmentType === "physical") {
      physicalEarnings += fee;
      physicalCount++;
    } else {
      videoEarnings += fee;
      videoCount++;
    }

    if (view === "weekly" && appt.appointmentDate) {
      weeklyByWeekday[new Date(appt.appointmentDate).getDay()] += fee;
    }
  }

  return {
    scope: "doctor",
    view,
    totalEarnings,
    totalAppointments: appointments.length,
    physical: { earnings: physicalEarnings, count: physicalCount },
    video: { earnings: videoEarnings, count: videoCount },
    weeklyByWeekday: view === "weekly" ? { labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], values: weeklyByWeekday } : null,
  };
};

/**
 * Helper to calculate admin-specific earnings
 */
const calculateAdminEarnings = (appointments, view) => {
  let totalDoctorFees = 0, totalAdminEarnings = 0, physicalAdminEarning = 0, videoAdminEarning = 0;
  const perDoctor = new Map();

  for (const appt of appointments) {
    const doc = appt.doctor;
    if (!doc) continue;

    const fee = Number(doc.fees?.amount || 0);
    const commission = Number(appt.adminEarning || 0);

    totalDoctorFees += fee;
    totalAdminEarnings += commission;

    if (appt.appointmentType === "video") videoAdminEarning += commission;
    else physicalAdminEarning += commission;

    const docId = String(doc._id);
    if (!perDoctor.has(docId)) {
      perDoctor.set(docId, { doctorId: docId, doctorName: doc.fullName || "", specialty: doc.specialty || "", appointments: 0, earnings: 0, adminCommission: 0 });
    }
    const entry = perDoctor.get(docId);
    entry.appointments++;
    entry.earnings += fee;
    entry.adminCommission += commission;
  }

  const doctors = Array.from(perDoctor.values());
  return {
    scope: "admin",
    view,
    totalDoctorFees,
    totalAdminEarnings,
    totalAppointments: appointments.length,
    avgPerDoctor: doctors.length > 0 ? totalDoctorFees / doctors.length : 0,
    physicalAdminEarning,
    videoAdminEarning,
    doctors,
  };
};

export const getEarningsOverview = catchAsync(async (req, res) => {
  const { role, _id: userId } = req.user;
  const view = (req.query.view || "monthly").toLowerCase();

  if (!["daily", "weekly", "monthly"].includes(view)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid view type");
  }

  const { start, end } = getDateRangeForView(view);
  const match = { status: "completed" };
  if (start && end) match.appointmentDate = { $gte: start, $lte: end };
  if (role === "doctor") match.doctor = userId;

  const appointments = await Appointment.find(match).populate("doctor", "fullName specialty fees").lean();
  const data = role === "doctor" ? calculateDoctorEarnings(appointments, view) : calculateAdminEarnings(appointments, view);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `${role} earnings overview fetched`,
    data,
  });
});

